function constructMessageBox(title, message, buttons) {
    title = title || (window.LauncherI18n ? window.LauncherI18n.t('common.error') : "Error");
    message = message || "";
    buttons = buttons || [window.LauncherI18n ? window.LauncherI18n.t('common.ok') : "OK"];

    return new Promise((resolve, reject) => {
        try{
            const messageBox = document.querySelector("#message-box");

            const resolveInternal = function() {
                messageBox.classList.remove("visible");
                // Its buttons stay in the page while hidden: out of reach of Tab and the arrows.
                messageBox.setAttribute("inert", "");
                return resolve.apply(this, arguments);
            };

            const titleElement = messageBox.querySelector(".mb-title");
            titleElement.innerHTML = title;

            const contentElement = messageBox.querySelector(".mb-content");
            contentElement.innerHTML = message;

            const buttonElement = messageBox.querySelector(".mb-buttons");
            buttonElement.textContent = "";

            messageBox.classList.add("visible");
            messageBox.removeAttribute("inert");

            // The button Escape (a pad's B) presses: the one marked cancel, else the first.
            const specs = buttons.map(value => typeof value === 'string' ? { label: value } : value);
            const marked = specs.findIndex(spec => spec.cancel);
            const escapeIndex = marked >= 0 ? marked : 0;

            specs.forEach((spec, index) => {
                var button = document.createElement("button");
                button.innerHTML = spec.label;
                if (spec.danger) button.classList.add('is-danger');
                if (index === escapeIndex) button.setAttribute('data-escape', '');
                button.addEventListener('click', resolveInternal.bind(this, index));
                buttonElement.appendChild(button);
            });
        }
        catch(e) {
            reject(e);
        }
    });
}

window.showMessageBox = function() {
    window.lastBox = window.lastBox || Promise.resolve();

    const newBox = window.lastBox.then(() => constructMessageBox.apply(this, arguments));
    window.lastBox = newBox;

    return newBox;
};
