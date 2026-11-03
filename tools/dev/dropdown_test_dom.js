// Minimal DOM adapter for Node behavior tests when Chromium cannot start in the Windows
// sandbox. This deliberately does not model browser layout, accessibility or pointer synthesis;
// dropdown_ui_test.py exercises those contracts in a real headless browser.
const observers = new Set();
let queued = false;
let records = [];
let document;

function mutation(target, extra = {}) {
    if (!target.isConnected) return;
    records.push({ target, type: 'attributes', addedNodes: [], ...extra });
    if (!queued) {
        queued = true;
        queueMicrotask(() => {
            queued = false;
            const batch = records;
            records = [];
            observers.forEach(observer => observer.callback(batch));
        });
    }
}

class Event {
    constructor(type, init = {}) { Object.assign(this, { type, bubbles: false, cancelable: false }, init); }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
}

class Target {
    constructor() { this.listeners = {}; }
    addEventListener(type, callback, capture = false) { (this.listeners[type] ||= []).push({ callback, capture }); }
    removeEventListener(type, callback) { this.listeners[type] = (this.listeners[type] || []).filter(item => item.callback !== callback); }
    dispatchEvent(event) {
        event.target = this;
        const path = [];
        for (let parent = this.parentElement; parent; parent = parent.parentElement) path.push(parent);
        if (this !== document && this.isConnected) path.push(document);
        const invoke = (target, capture) => {
            for (const listener of target.listeners[event.type] || []) {
                if (listener.capture === capture) listener.callback.call(target, event);
            }
        };
        [...path].reverse().forEach(target => { if (!event.stopped) invoke(target, true); });
        if (!event.stopped) { invoke(this, true); invoke(this, false); }
        if (event.bubbles) path.forEach(target => { if (!event.stopped) invoke(target, false); });
        return !event.defaultPrevented;
    }
}

const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, token => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[token]);
class Element extends Target {
    constructor(tagName) {
        super();
        this.tagName = tagName.toUpperCase(); this.nodeType = 1;
        this.children = []; this.attributes = {}; this.style = {}; this._text = '';
        this.scrollTop = 0;
        this.rect = { left: 20, top: 100, right: 260, bottom: 136, width: 240, height: 36 };
        this.dataset = new Proxy({}, {
            get: (_, key) => this.getAttribute(`data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`) ?? undefined,
            set: (_, key, value) => { this.setAttribute(`data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value); return true; }
        });
        this.classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            add: name => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
            remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(' '); },
            toggle: (name, on = !this.classList.contains(name)) => { this.classList[on ? 'add' : 'remove'](name); }
        };
    }
    get isConnected() { return this === document.documentElement || !!this.parentElement?.isConnected; }
    get parentNode() { return this === document.documentElement ? document : this.parentElement; }
    get childNodes() { return this.children; }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get name() { return this.getAttribute('name') || ''; }
    get tabIndex() { return Number(this.getAttribute('tabindex') ?? 0); }
    set tabIndex(value) { this.setAttribute('tabindex', value); }
    get label() { return this.getAttribute('label') ?? this.textContent; }
    get htmlFor() { return this.getAttribute('for'); }
    set htmlFor(value) { this.setAttribute('for', value); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get value() { return this.getAttribute('value') ?? this.textContent; }
    set value(value) { this.setAttribute('value', value); }
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); mutation(this, { type: 'childList' }); }
    set innerHTML(value) { this.replaceChildren(); parse(value, this); }
    setAttribute(name, value) {
        if (this.attributes[name] === String(value)) return;
        this.attributes[name] = String(value); mutation(this, { attributeName: name });
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    removeAttribute(name) { if (this.hasAttribute(name)) { delete this.attributes[name]; mutation(this, { attributeName: name }); } }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; mutation(this, { type: 'childList', addedNodes: [child] }); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    remove() { if (this.parentElement) { const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; mutation(parent, { type: 'childList' }); } }
    replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = ''; this.append(...children); mutation(this, { type: 'childList' }); }
    insertAdjacentElement(where, child) {
        if (where !== 'afterend') throw new Error(where);
        const parent = this.parentElement;
        parent.children.splice(parent.children.indexOf(this) + 1, 0, child); child.parentElement = parent;
        mutation(parent, { type: 'childList', addedNodes: [child] });
    }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    matches(selector) {
        return selector.split(',').some(part => {
            part = part.trim();
            const not = part.match(/:not\((.*?)\)/);
            if (not) { if (this.matches(not[1])) return false; part = part.replace(not[0], ''); }
            const tag = part.match(/^[a-z][\w-]*/i);
            if (tag && this.tagName !== tag[0].toUpperCase()) return false;
            for (const match of part.matchAll(/([.#])([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
                if (match[1] === '.' && !this.classList.contains(match[2])) return false;
                if (match[1] === '#' && this.id !== match[2]) return false;
                if (match[3] && (!this.hasAttribute(match[3]) || (match[4] !== undefined && this.getAttribute(match[3]) !== match[4]))) return false;
            }
            return true;
        });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() {
        if (this.disabled || document.activeElement === this) return;
        const previous = document.activeElement;
        document.activeElement = this;
        previous?.dispatchEvent(new Event('blur'));
        previous?.dispatchEvent(new Event('focusout', { bubbles: true }));
        this.dispatchEvent(new Event('focusin', { bubbles: true }));
    }
    scrollIntoView(options) { this.lastScrollIntoView = options; }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
    getClientRects() { return !this.isConnected || this.closest('[hidden]') || this.style.display === 'none' || this.classList.contains('launcher-dropdown-source') ? [] : [this.rect]; }
    getBoundingClientRect() { return this.rect; }
    get offsetWidth() { return parseFloat(this.style.width) || this.rect.width; }
    get scrollHeight() { return this.children.length * 36 + 8; }
    get offsetHeight() { return Math.min(this.scrollHeight, parseFloat(this.style.maxHeight) || 320); }
    get clientHeight() { return this.offsetHeight; }
    get offsetTop() { return (this.parentElement?.children.indexOf(this) || 0) * 36; }
}

class Select extends Element {
    constructor() { super('select'); this._index = null; }
    get options() { return this.querySelectorAll('option'); }
    get labels() { return document.querySelectorAll(`label[for="${this.id}"]`); }
    get multiple() { return this.hasAttribute('multiple'); }
    get size() { return Number(this.getAttribute('size') || 0); }
    get selectedIndex() { return this._index ?? Math.max(this.options.findIndex(option => option.hasAttribute('selected')), this.options.length ? 0 : -1); }
    set selectedIndex(value) { this._index = Number(value); }
    get value() { return this.options[this.selectedIndex]?.value ?? ''; }
    set value(value) { this._index = this.options.findIndex(option => option.value === String(value)); }
}

function parse(markup, root) {
    const stack = [root];
    const voids = new Set(['input', 'img', 'br', 'hr', 'link', 'meta', 'base']);
    for (const token of markup.matchAll(/<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)([^>]*?)>|([^<]+)/g)) {
        if (token[1]) { if (stack.length > 1) stack.pop(); }
        else if (token[2]) {
            const tag = token[2].toLowerCase();
            const element = tag === 'select' ? new Select() : new Element(tag);
            for (const attribute of token[3].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
                element.setAttribute(attribute[1], decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
            }
            stack.at(-1).append(element);
            if (!voids.has(tag) && !token[3].endsWith('/')) stack.push(element);
        } else if (token[4]) stack.at(-1)._text += decode(token[4]);
    }
}

function createDOM() {
    document = new Target(); document.nodeType = 9;
    document.createElement = tag => tag === 'select' ? new Select() : new Element(tag);
    document.documentElement = new Element('html'); document.body = new Element('body');
    document.documentElement.append(document.body);
    document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
    document.querySelector = selector => document.documentElement.querySelector(selector);
    document.getElementById = id => document.querySelector(`#${id}`);
    const window = new Target();
    Object.assign(window, { document, innerWidth: 1280, innerHeight: 800, KeyboardEvent: Event });
    class MutationObserver {
        constructor(callback) { this.callback = callback; }
        observe() { observers.add(this); }
    }
    return { window, document, HTMLSelectElement: Select, Event, CustomEvent: Event, KeyboardEvent: Event, MutationObserver,
             setTimeout, clearTimeout, console, localStorage: { getItem: () => null }, queueMicrotask,
             navigator: { getGamepads: () => [] }, requestAnimationFrame: () => 0 };
}
module.exports = { createDOM };
