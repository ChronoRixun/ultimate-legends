'use strict';
// What the launcher UI's unit tests (src/tests/ui) run the real UI scripts in: a small DOM (enough
// of Element, Event and document for the views: innerHTML in, querySelector / events / select
// values out; no layout, no CSS), a fake clock that drives every timer and Date.now, and a page
// that loads scripts from src/launcher-ui into one context the way main.html does, with
// window.executeCommand going to a test's fake backend. Node only, no packages.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UI = path.resolve(__dirname, '../../launcher-ui/assets/js');
const MAIN_HTML = path.resolve(__dirname, '../../launcher-ui/main.html');

// ---- events ----

class Event {
    constructor(type, init = {}) {
        this.type = type;
        this.bubbles = !!init.bubbles;
        this.defaultPrevented = false;
        this.target = null;
        this.currentTarget = null;
        this.stopped = false;
    }

    preventDefault() {
        this.defaultPrevented = true;
    }

    stopPropagation() {
        this.stopped = true;
    }
}

class CustomEvent extends Event {
    constructor(type, init = {}) {
        super(type, init);
        this.detail = init.detail === undefined ? null : init.detail;
    }
}

class Target {
    constructor() {
        this.listeners = [];
    }

    addEventListener(type, fn, options) {
        const capture = options === true || !!(options && options.capture);
        this.listeners.push({ type, fn, capture });
    }

    removeEventListener(type, fn, options) {
        const capture = options === true || !!(options && options.capture);
        this.listeners = this.listeners.filter(l => !(l.type === type && l.fn === fn && l.capture === capture));
    }

    // phase: 'capture' (capture listeners), 'target' (all), 'bubble' (the others).
    fire(event, phase) {
        for (const listener of this.listeners.slice()) {
            if (listener.type !== event.type || event.stopped) continue;
            if (phase === 'capture' && !listener.capture) continue;
            if (phase === 'bubble' && listener.capture) continue;
            event.currentTarget = this;
            listener.fn.call(this, event);
        }
    }

    dispatchEvent(event) {
        event.target = event.target || this;
        this.fire(event, 'target');
        return !event.defaultPrevented;
    }
}

// ---- nodes ----

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
        if (name[0] === '#') {
            return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
        }
        return ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : match;
    });
}

class Node extends Target {
    constructor(document) {
        super();
        this.ownerDocument = document;
        this.parentNode = null;
        this.childNodes = [];
    }

    get parentElement() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }

    get children() {
        return this.childNodes.filter(node => node.nodeType === 1);
    }

    get textContent() {
        return this.childNodes.map(node => node.textContent).join('');
    }

    appendChild(node) {
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }

    removeChild(node) {
        this.childNodes = this.childNodes.filter(child => child !== node);
        node.parentNode = null;
        return node;
    }

    *descendants() {
        for (const child of this.childNodes) {
            if (child.nodeType !== 1) continue;
            yield child;
            yield* child.descendants();
        }
    }

    querySelectorAll(selector) {
        const found = [];
        for (const element of this.descendants()) {
            if (element.matches(selector)) found.push(element);
        }
        return found;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    // Capture from the root down, the target, then bubbling up.
    dispatchEvent(event) {
        event.target = this;
        const ancestors = [];
        for (let node = this.parentNode; node; node = node.parentNode) ancestors.push(node);
        for (const node of ancestors.slice().reverse()) node.fire(event, 'capture');
        this.fire(event, 'target');
        if (event.bubbles) {
            for (const node of ancestors) node.fire(event, 'bubble');
        }
        return !event.defaultPrevented;
    }
}

class Text extends Node {
    constructor(document, data) {
        super(document);
        this.nodeType = 3;
        this.data = data;
    }

    get textContent() {
        return this.data;
    }
}

function parseInto(parent, html) {
    const document = parent.ownerDocument;
    const stack = [parent];
    const top = () => stack[stack.length - 1];
    const tag = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
    const attribute = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let last = 0;
    let match;
    while ((match = tag.exec(html))) {
        if (match.index > last) top().appendChild(new Text(document, decode(html.slice(last, match.index))));
        last = tag.lastIndex;
        if (match[0].startsWith('<!--')) continue;
        if (match[1]) {
            const name = match[1].toUpperCase();
            const index = stack.map(node => node.tagName).lastIndexOf(name);
            if (index > 0) stack.length = index;
            continue;
        }
        const element = new Element(document, match[2]);
        let part;
        attribute.lastIndex = 0;
        while ((part = attribute.exec(match[3] || ''))) {
            const value = part[2] !== undefined ? part[2] : part[3] !== undefined ? part[3] : part[4] !== undefined ? part[4] : '';
            element.setAttribute(part[1].toLowerCase(), decode(value));
        }
        top().appendChild(element);
        if (!match[4] && !VOID.has(element.localName)) stack.push(element);
    }
    if (last < html.length) top().appendChild(new Text(document, decode(html.slice(last))));
}

// ---- selectors: tag, #id, .class, [attr], [attr="value"]; descendant and child combinators ----

function parseCompound(text) {
    const compound = { tag: null, id: null, classes: [], attributes: [] };
    const head = /^([a-zA-Z*][\w-]*)/.exec(text);
    let rest = text;
    if (head) {
        compound.tag = head[1] === '*' ? null : head[1].toUpperCase();
        rest = text.slice(head[1].length);
    }
    const part = /#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/g;
    let match;
    let consumed = 0;
    while ((match = part.exec(rest))) {
        if (match.index !== consumed) throw new Error(`selector not supported: ${text}`);
        consumed = part.lastIndex;
        if (match[1]) compound.id = match[1];
        else if (match[2]) compound.classes.push(match[2]);
        else compound.attributes.push({ name: match[3].toLowerCase(), value: match[4] !== undefined ? match[4] : match[5] !== undefined ? match[5] : match[6] });
    }
    if (consumed !== rest.length) throw new Error(`selector not supported: ${text}`);
    return compound;
}

function parseSelector(selector) {
    const steps = [];
    let current = '';
    let depth = 0;
    let quote = null;
    let combinator = ' ';
    const flush = () => {
        if (current) steps.push({ combinator, compound: parseCompound(current) });
        current = '';
    };
    for (const c of selector.trim()) {
        if (quote) {
            if (c === quote) quote = null;
            current += c;
        } else if (c === '"' || c === "'") {
            quote = c;
            current += c;
        } else if (c === '[') {
            depth++;
            current += c;
        } else if (c === ']') {
            depth--;
            current += c;
        } else if (depth === 0 && (c === ' ' || c === '>')) {
            if (current) {
                flush();
                combinator = ' ';
            }
            if (c === '>') combinator = '>';
        } else {
            current += c;
        }
    }
    flush();
    return steps;
}

function matchesCompound(element, compound) {
    if (compound.tag && element.tagName !== compound.tag) return false;
    if (compound.id && element.id !== compound.id) return false;
    if (compound.classes.some(name => !element.classList.contains(name))) return false;
    return compound.attributes.every(({ name, value }) => element.hasAttribute(name) && (value === undefined || element.getAttribute(name) === value));
}

function matchesSteps(element, steps, index) {
    if (!element || element.nodeType !== 1 || !matchesCompound(element, steps[index].compound)) return false;
    if (index === 0) return true;
    if (steps[index].combinator === '>') return matchesSteps(element.parentNode, steps, index - 1);
    for (let node = element.parentNode; node && node.nodeType === 1; node = node.parentNode) {
        if (matchesSteps(node, steps, index - 1)) return true;
    }
    return false;
}

class Element extends Node {
    constructor(document, tagName) {
        super(document);
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.attributes = new Map();
        this.style = {
            setProperty(name, value) { this[name] = String(value); },
            removeProperty(name) { delete this[name]; },
            getPropertyValue(name) { return this[name] || ''; }
        };
        this.inputValue = undefined;
        this.chosen = undefined; // an option picked through select.value (else its selected attribute)
        this.noneChosen = false; // a select set to a value none of its options has
    }

    get localName() {
        return this.tagName.toLowerCase();
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    toggleAttribute(name, on) {
        if (on) this.setAttribute(name, '');
        else this.removeAttribute(name);
    }

    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(on) { this.toggleAttribute('hidden', !!on); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(on) { this.toggleAttribute('disabled', !!on); }
    get checked() { return this.hasAttribute('checked'); }
    set checked(on) { this.toggleAttribute('checked', !!on); }

    get classList() {
        const element = this;
        const names = () => element.className.split(/\s+/).filter(Boolean);
        const list = {
            contains: name => names().includes(name),
            add: (...added) => {
                element.className = [...new Set([...names(), ...added])].join(' ');
            },
            remove: (...removed) => {
                element.className = names().filter(name => !removed.includes(name)).join(' ');
            },
            toggle: (name, force) => {
                const on = force === undefined ? !names().includes(name) : !!force;
                if (on) list.add(name);
                else list.remove(name);
                return on;
            }
        };
        return list;
    }

    get dataset() {
        const element = this;
        const attribute = key => 'data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
        return new Proxy({}, {
            get: (_, key) => (typeof key === 'string' && element.hasAttribute(attribute(key)) ? element.getAttribute(attribute(key)) : undefined),
            set: (_, key, value) => {
                element.setAttribute(attribute(key), value);
                return true;
            }
        });
    }

    set textContent(value) {
        this.childNodes.forEach(node => { node.parentNode = null; });
        this.childNodes = [];
        if (value !== '' && value !== null && value !== undefined) this.appendChild(new Text(this.ownerDocument, String(value)));
    }

    get textContent() {
        return super.textContent;
    }

    get innerText() { return this.textContent; }
    set innerText(value) { this.textContent = value; }

    set innerHTML(html) {
        this.textContent = '';
        parseInto(this, String(html));
    }

    get innerHTML() {
        const serialise = node => {
            if (node.nodeType === 3) return node.data;
            const attributes = [...node.attributes].map(([name, value]) => ` ${name}="${value}"`).join('');
            if (VOID.has(node.localName)) return `<${node.localName}${attributes}>`;
            return `<${node.localName}${attributes}>${node.childNodes.map(serialise).join('')}</${node.localName}>`;
        };
        return this.childNodes.map(serialise).join('');
    }

    matches(selector) {
        return selector.split(',').some(one => {
            const steps = parseSelector(one);
            return matchesSteps(this, steps, steps.length - 1);
        });
    }

    closest(selector) {
        for (let node = this; node && node.nodeType === 1; node = node.parentNode) {
            if (node.matches(selector)) return node;
        }
        return null;
    }

    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }

    click() {
        if (this.disabled) return;
        this.dispatchEvent(new Event('click', { bubbles: true }));
    }

    // The focused element is document.activeElement (no focus events: no view listens for them).
    focus() {
        if (!this.disabled) this.ownerDocument.activeElement = this;
    }

    blur() {
        if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
    }

    scrollIntoView() {}

    getBoundingClientRect() {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }

    get options() {
        return this.querySelectorAll('option');
    }

    selectedOption() {
        if (this.noneChosen) return null;
        const options = this.options;
        const picked = options.filter(option => (option.chosen !== undefined ? option.chosen : option.hasAttribute('selected')));
        return picked.length ? picked[picked.length - 1] : options[0] || null;
    }

    get value() {
        if (this.tagName === 'SELECT') {
            const option = this.selectedOption();
            return option ? option.value : '';
        }
        if (this.tagName === 'OPTION') return this.hasAttribute('value') ? this.getAttribute('value') : this.textContent;
        return this.inputValue !== undefined ? this.inputValue : this.getAttribute('value') || '';
    }

    set value(value) {
        if (this.tagName === 'SELECT') {
            let found = false;
            for (const option of this.options) {
                option.chosen = !found && option.value === String(value);
                found = found || option.chosen;
            }
            this.noneChosen = !found;
            return;
        }
        if (this.tagName === 'OPTION') {
            this.setAttribute('value', value);
            return;
        }
        this.inputValue = String(value);
    }
}

class Document extends Node {
    constructor() {
        super(null);
        this.ownerDocument = this;
        this.nodeType = 9;
        this.visibilityState = 'visible';
        this.documentElement = this.appendChild(new Element(this, 'html'));
        this.body = this.documentElement.appendChild(new Element(this, 'body'));
        this.head = new Element(this, 'head');
        this.activeElement = this.body;
    }

    createElement(tagName) {
        return new Element(this, tagName);
    }

    createTextNode(data) {
        return new Text(this, data);
    }

    getElementById(id) {
        for (const element of this.descendants()) {
            if (element.id === id) return element;
        }
        return null;
    }
}

// ---- time ----

// Every setTimeout / setInterval of a page and its Date.now: time moves only when a test says so,
// and each timer runs with the microtasks it starts settled before the next one.
class Clock {
    constructor() {
        this.now = 0;
        this.timers = new Map();
        this.sequence = 0;
    }

    setTimeout(fn, ms, ...args) {
        const id = ++this.sequence;
        this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn, args, every: null, id });
        return id;
    }

    setInterval(fn, ms, ...args) {
        const id = ++this.sequence;
        const every = Math.max(1, Number(ms) || 0);
        this.timers.set(id, { at: this.now + every, fn, args, every, id });
        return id;
    }

    clear(id) {
        this.timers.delete(id);
    }

    next() {
        let first = null;
        for (const timer of this.timers.values()) {
            if (!first || timer.at < first.at || (timer.at === first.at && timer.id < first.id)) first = timer;
        }
        return first;
    }

    async runNext() {
        const timer = this.next();
        this.now = Math.max(this.now, timer.at);
        if (timer.every) timer.at += timer.every;
        else this.timers.delete(timer.id);
        timer.fn(...timer.args);
        await settle();
    }

    // Runs the timers due in the next `ms` milliseconds.
    async advance(ms) {
        const end = this.now + ms;
        await settle();
        for (let timer = this.next(); timer && timer.at <= end; timer = this.next()) await this.runNext();
        this.now = end;
        await settle();
    }

    // Runs timers until `condition()` holds; fails after `ms` milliseconds of page time.
    async until(condition, ms, what) {
        const end = this.now + ms;
        await settle();
        while (!condition()) {
            const timer = this.next();
            if (!timer || timer.at > end) throw new Error(`still waiting after ${ms} ms: ${what}`);
            await this.runNext();
        }
    }
}

// Lets every promise chain already started run to its next timer or command.
async function settle() {
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}

// ---- the page ----

// main.html's body (the window, the global progress bar, the message box...) without its scripts.
function mainBody() {
    const html = fs.readFileSync(MAIN_HTML, 'utf8');
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    return (body ? body[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

// Loads `scripts` (paths under src/launcher-ui/assets/js) into a fresh page whose commands go to
// `backend.handle(command, data)` (a value or a promise): main.html's body, then `body`.
function page({ scripts, backend, body = '', clock = new Clock(), offline = false }) {
    const document = new Document();
    document.body.innerHTML = mainBody() + body;
    const window = new Target();
    const logs = [];
    const toasts = [];
    const messages = [];
    const context = {
        document,
        Event,
        CustomEvent,
        console: {
            log: (...args) => logs.push(['log', ...args]),
            info: (...args) => logs.push(['info', ...args]),
            warn: (...args) => logs.push(['warn', ...args]),
            error: (...args) => logs.push(['error', ...args]),
            debug: () => {}
        },
        setTimeout: (...args) => clock.setTimeout(...args),
        clearTimeout: id => clock.clear(id),
        setInterval: (...args) => clock.setInterval(...args),
        clearInterval: id => clock.clear(id),
        requestAnimationFrame: fn => clock.setTimeout(fn, 16),
        navigator: { userAgent: 'ui-tests', clipboard: { writeText: async () => {} } },
        location: { protocol: 'https:', hostname: 'launcher', href: 'https://launcher/' },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        IS_OFFLINE: offline,
        __clock: clock
    };
    context.window = context;
    context.self = context;
    context.addEventListener = window.addEventListener.bind(window);
    context.removeEventListener = window.removeEventListener.bind(window);
    context.dispatchEvent = window.dispatchEvent.bind(window);
    context.executeCommand = (command, data) => Promise.resolve().then(() => backend.handle(command, data === undefined ? null : data));
    context.showToast = (...args) => toasts.push(args);
    context.showMessageBox = async (...args) => {
        messages.push(args);
        return 0;
    };
    vm.createContext(context);
    vm.runInContext('Date.now = () => __clock.now;', context);
    for (const script of scripts) {
        const file = path.join(UI, script);
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
    return { window: context, document, clock, logs, toasts, messages };
}

// ---- tests ----

const tests = [];

function test(name, run) {
    tests.push({ name, run });
}

module.exports = { Clock, Event, CustomEvent, page, settle, test, tests };
