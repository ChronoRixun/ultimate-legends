// Set up X-Men Legends (community port): the wizard of BUILDER_DESIGN.md 4.3.
//   1. Requirements: X-Men Legends II set up, the player's own Xbox disc image, a folder, free space.
//   2. Disc check: installs the builder when needed, then runs its `info`: the disc, XML2, space,
//      a time estimate; the build options (Advanced).
//   3. Building: the builder's stages, progress, time left; Cancel, or Hide (it keeps going).
//   4. Finishing: the XML2 Fix goes into the new folder -> Ready: Play / Open folder.
//   Failure: the translated error, Copy details / Open log / Report on GitHub, Resume.
// Also the uninstall dialog (4.6). State and runs live in Xml1Port (xml1-port.js).
(function () {
    'use strict';

    const GAME = 'xml1';
    // The builder copies XML2's files even with --link-base (W_LINK_BASE) until it supports hard links, so the
    // option stays hidden; flip this when a builder release links them.
    const LINK_BASE_SUPPORTED = false;
    const escapeHtml = value => GameUtils.escapeHtml(value);

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    function bytes(value) {
        return GameUtils.formatBytes(Math.max(0, Number(value) || 0));
    }

    const NEED_BYTES = 7 * 1024 * 1024 * 1024; // output + cache, movies on (design 1.3)

    class Xml1SetupPopup {
        constructor() {
            this.backdrop = null;
            this.step = 'requirements';
            this.form = null;
            this.check = null;      // the disc check: { job, info, error }
            this.busy = '';         // what the check step is doing right now
            this.free = null;       // free bytes where the game goes
            this.startError = null;
            this.zipNote = null;    // how installing a builder zip the player chose went: { ok, text }
            this.rendered = '';
            // The build's steps follow every change; the other steps only re-render on the player's
            // actions (a re-render would drop the focus of a field being typed in).
            this.onChange = () => {
                const step = this.currentStep();
                if (step !== this.rendered || !['requirements', 'check'].includes(step)) this.render();
            };
        }

        port() {
            return window.Xml1Port;
        }

        async show() {
            const port = this.port();
            await port.refresh();
            const s = port.status;
            if (!this.form || !this.backdrop) {
                this.form = {
                    iso: s.iso || '',
                    out: s.install || s.defaultOut || '',
                    movies: s.movies !== false,
                    keepCache: s.keepCache !== false,
                    linkBase: LINK_BASE_SUPPORTED && !!s.linkBase
                };
            }
            this.step = port.isBuilding() || port.finishing ? 'build' : 'requirements';
            this.check = null;
            this.startError = null;
            this.open();
            this.updateFreeSpace();
            // Say up front whether the builder can be had (released? reachable?), not after the
            // player has filled everything in.
            if (!s.builder.installed && !s.builder.checking && !s.builder.installing && !window.IS_OFFLINE) {
                port.checkBuilder(false).then(() => {
                    if (this.currentStep() === 'requirements') this.render();
                });
            }
        }

        open() {
            if (!this.backdrop) {
                this.backdrop = document.createElement('div');
                this.backdrop.className = 'component-selection-backdrop xml1-setup-backdrop';
                this.backdrop.innerHTML = `
                    <div class="component-selection-popup xml1-setup">
                        <div class="popup-header">
                            <h3 class="xml1-setup-title"></h3>
                            <button class="popup-close" type="button" title="${escapeHtml(t('xml1.hide'))}"></button>
                        </div>
                        <div class="popup-content xml1-setup-content"></div>
                    </div>`;
                document.body.appendChild(this.backdrop);
                this.backdrop.querySelector('.popup-close').addEventListener('click', () => this.hide());
                window.addEventListener('ul-xml1-changed', this.onChange);
            }
            this.render();
            this.backdrop.style.display = 'flex';
            requestAnimationFrame(() => {
                this.backdrop.classList.add('active');
                this.backdrop.querySelector('.xml1-setup').classList.add('active');
            });
        }

        hide() {
            if (!this.backdrop) return;
            window.removeEventListener('ul-xml1-changed', this.onChange);
            this.backdrop.remove();
            this.backdrop = null;
        }

        isOpen() {
            return !!this.backdrop;
        }

        // The build steps follow the build itself, whoever started it.
        currentStep() {
            if (this.step !== 'build') return this.step;
            const port = this.port();
            if (port.isBuilding()) return 'build';
            if (port.finishing) return 'finishing';
            const job = port.build;
            if (!job || job.command !== 'build') return 'requirements';
            if (job.exitCode === 0) return 'done';
            if (job.exitCode === 5) return 'cancelled';
            return 'failed';
        }

        render() {
            if (!this.backdrop) return;
            const step = this.currentStep();
            const title = {
                requirements: t('xml1.setupTitle'),
                check: t('xml1.setupTitle'),
                build: t('xml1.buildingTitle'),
                finishing: t('xml1.finishingTitle'),
                done: t('xml1.readyTitle'),
                cancelled: t('xml1.cancelledTitle'),
                failed: t('xml1.failedTitle')
            }[step];
            this.backdrop.querySelector('.xml1-setup-title').textContent = title;
            const content = this.backdrop.querySelector('.xml1-setup-content');
            content.dataset.step = step;
            const html = {
                requirements: () => this.requirementsHTML(),
                check: () => this.checkHTML(),
                build: () => this.buildHTML(),
                finishing: () => this.finishingHTML(),
                done: () => this.doneHTML(),
                cancelled: () => this.cancelledHTML(),
                failed: () => this.failedHTML()
            }[step]();

            // A field being typed in keeps its focus and caret across a re-render.
            const active = document.activeElement;
            const field = active && content.contains(active) && active.dataset ? active.dataset.field : null;
            const caret = field ? [active.selectionStart, active.selectionEnd] : null;
            content.innerHTML = html;
            this.rendered = step;
            this.bind(content, step);
            if (field) {
                const input = content.querySelector(`[data-field="${field}"]`);
                if (input) {
                    input.focus();
                    try { input.setSelectionRange(caret[0], caret[1]); } catch (_) { /* not a text field */ }
                }
            }
        }

        // ---- 1. requirements ----

        // Everything the disc check needs: XML2, a disc image, a folder, and a builder that exists.
        canCheck() {
            const s = this.port().status;
            const builder = s.builder || {};
            return !!(s.xml2.setUp && this.form.iso.trim() && this.form.out.trim() && (builder.installed || !builder.notPublished));
        }

        requirementsHTML() {
            const s = this.port().status;
            const builder = s.builder || {};
            const f = this.form;
            const ready = this.canCheck();
            const freeText = this.free == null ? ''
                : (this.free < NEED_BYTES
                    ? `<span class="xml1-warn">${escapeHtml(t('xml1.lowSpace', { free: bytes(this.free), need: bytes(NEED_BYTES) }))}</span>`
                    : escapeHtml(t('xml1.freeSpace', { free: bytes(this.free), need: bytes(NEED_BYTES) })));
            let builderText;
            if (builder.installed && !builder.updateAvailable) builderText = t('xml1.builderInstalled', { version: builder.version });
            else if (builder.installed) builderText = t('xml1.builderUpdate', { version: builder.version, latest: builder.latest.version });
            else if (builder.notPublished) builderText = t('xml1.errors.L_BUILDER_UNPUBLISHED.msg');
            else if (builder.latest) builderText = t('xml1.builderWillDownload', { version: builder.latest.version, size: bytes(builder.latest.size) });
            else if (builder.code) builderText = this.port().describe({ code: builder.code, msg: builder.error }).title;
            else builderText = t('xml1.builderUnknown');
            // A builder zip the player already has (a slow or metered connection, or a download that
            // failed): offered while the builder is missing or out of date.
            const offerZip = !builder.notPublished && (!builder.installed || builder.updateAvailable) && !builder.installing;
            const zipNote = this.zipNote
                ? `<div class="xml1-req-detail xml1-zip-note ${this.zipNote.ok ? 'is-ok' : 'is-error'}">${escapeHtml(this.zipNote.text)}</div>` : '';
            const resumeNote = s.state === 'incomplete'
                ? `<p class="xml1-note is-info">${escapeHtml(t(s.isoExists || s.cacheHasDisc ? 'xml1.resumeNote' : 'xml1.resumeNeedsDisc'))}</p>` : '';

            return `
                <p class="install-note xml1-intro">${escapeHtml(t('xml1.intro'))}</p>
                ${resumeNote}
                <div class="xml1-reqs">
                    <div class="xml1-req ${s.xml2.setUp ? 'is-ok' : 'is-missing'}" data-req="xml2">
                        <span class="xml1-mark"></span>
                        <div class="xml1-req-body">
                            <div class="xml1-req-title">${escapeHtml(t('xml1.reqXml2'))}</div>
                            <div class="xml1-req-detail">${escapeHtml(s.xml2.setUp ? s.xml2.path : t('xml1.reqXml2Missing'))}</div>
                        </div>
                        ${s.xml2.setUp ? '' : `<button type="button" class="secondary-action xml1-small" data-act="setup-xml2">${escapeHtml(t('xml1.setUpXml2'))}</button>`}
                    </div>
                    <div class="xml1-req ${f.iso ? 'is-ok' : 'is-todo'}" data-req="iso">
                        <span class="xml1-mark"></span>
                        <div class="xml1-req-body">
                            <div class="xml1-req-title">${escapeHtml(t('xml1.reqDisc'))}</div>
                            <div class="xml1-field">
                                <input type="text" class="xml1-input" data-field="iso" spellcheck="false" value="${escapeHtml(f.iso)}" placeholder="${escapeHtml(t('xml1.discPlaceholder'))}">
                                <button type="button" class="secondary-action xml1-small" data-act="browse-iso">${escapeHtml(t('common.browse'))}</button>
                            </div>
                            <div class="xml1-req-detail"><a href="#" data-act="how-to-dump">${escapeHtml(t('xml1.howToDump'))}</a></div>
                        </div>
                    </div>
                    <div class="xml1-req ${f.out ? 'is-ok' : 'is-todo'}" data-req="out">
                        <span class="xml1-mark"></span>
                        <div class="xml1-req-body">
                            <div class="xml1-req-title">${escapeHtml(t('xml1.reqDestination'))}</div>
                            <div class="xml1-field">
                                <input type="text" class="xml1-input" data-field="out" spellcheck="false" value="${escapeHtml(f.out)}">
                                <button type="button" class="secondary-action xml1-small" data-act="browse-out">${escapeHtml(t('common.browse'))}</button>
                            </div>
                            <div class="xml1-req-detail xml1-free">${freeText || escapeHtml(t('xml1.destinationHint'))}</div>
                        </div>
                    </div>
                    <div class="xml1-req ${builder.installed ? 'is-ok' : (builder.notPublished ? 'is-missing' : 'is-todo')}" data-req="builder">
                        <span class="xml1-mark"></span>
                        <div class="xml1-req-body">
                            <div class="xml1-req-title">${escapeHtml(t('xml1.reqBuilder'))}</div>
                            <div class="xml1-req-detail">${escapeHtml(builderText)}</div>
                            ${zipNote}
                            ${offerZip ? `<div class="xml1-req-detail"><a href="#" data-act="builder-zip">${escapeHtml(t('xml1.useBuilderZip'))}</a></div>` : ''}
                        </div>
                    </div>
                </div>
                <p class="install-note xml1-byoc">${escapeHtml(t('xml1.byoc'))}</p>
                <div class="popup-actions">
                    <button type="button" class="btn-cancel" data-act="close">${escapeHtml(t('common.cancel'))}</button>
                    <button type="button" class="btn-apply" data-act="check" ${ready ? '' : 'disabled'}>${escapeHtml(t('xml1.checkDisc'))}</button>
                </div>`;
        }

        async updateFreeSpace() {
            const out = this.form && this.form.out.trim();
            if (!out) {
                this.free = null;
                return;
            }
            try {
                const answer = await run('xml1-free-space', { path: out });
                this.free = answer && answer.free != null ? answer.free : null;
            } catch (_) {
                this.free = null;
            }
            if (this.currentStep() === 'requirements') this.render();
        }

        // ---- 2. disc check ----

        async runCheck() {
            const port = this.port();
            this.step = 'check';
            this.check = null;
            this.busy = t('xml1.checkingBuilder');
            this.render();

            let builder = port.status.builder;
            if (!builder.installed || builder.updateAvailable) {
                builder = await port.checkBuilder(true, state => {
                    if (state.installing) {
                        const percent = state.total ? Math.floor(100 * state.done / state.total) : 0;
                        this.busy = t('xml1.installingBuilder', { percent });
                        this.render();
                    }
                });
                if (!builder.installed) {
                    this.busy = '';
                    this.check = { error: port.describe({ code: builder.code || 'L_BUILDER_MISSING', msg: builder.error }) };
                    this.render();
                    return;
                }
            }

            this.busy = t('xml1.checking');
            this.render();
            const out = this.form.out.trim();
            const job = await port.runJob('xml1-info', { iso: this.form.iso.trim(), out });
            this.busy = '';
            const info = job && job.result && job.result.info;
            if (!job || job.exitCode !== 0 || !info) {
                this.check = { job, error: port.jobError(job) };
            } else {
                // A folder holding only the launcher's and the player's files (dinput.dll, xml2-fix.*,
                // mods\) is "absent" to the builder (its `build` takes it); the wizard says they are kept.
                let folder = null;
                try {
                    folder = await run('xml1-folder', { path: out });
                } catch (_) { /* the builder's word stands */ }
                this.check = { job, info, folder, launcherOnly: !!(folder && folder.launcherOnly && info.out && info.out.state === 'absent') };
            }
            this.render();
        }

        checkHTML() {
            if (this.busy) {
                return `<div class="xml1-busy"><span class="xml1-spinner"></span>${escapeHtml(this.busy)}</div>`;
            }
            const check = this.check || {};
            if (check.error) {
                return `
                    ${this.errorHTML(check.error)}
                    <div class="popup-actions">
                        <button type="button" class="btn-cancel" data-act="back">${escapeHtml(t('xml1.back'))}</button>
                    </div>`;
            }

            const info = check.info;
            const iso = info.iso || {};
            const xml2 = info.xml2 || {};
            const out = info.out || {};
            const space = (info.space && info.space.out) || null;
            const cacheSpace = (info.space && info.space.cache) || null;
            const estimate = info.estimate || {};
            const foreign = out.state === 'foreign' && !check.launcherOnly;
            const spaceOk = !space || space.ok;
            const minutes = Math.max(1, Math.round((estimate.first_build_s || 0) / 60));
            const f = this.form;

            const row = (ok, title, detail) => `
                <div class="xml1-req ${ok ? 'is-ok' : 'is-missing'}">
                    <span class="xml1-mark"></span>
                    <div class="xml1-req-body">
                        <div class="xml1-req-title">${escapeHtml(title)}</div>
                        ${detail ? `<div class="xml1-req-detail">${escapeHtml(detail)}</div>` : ''}
                    </div>
                </div>`;

            const outDetail = foreign ? t('xml1.outForeign')
                : check.launcherOnly ? t('xml1.outLauncherOnly', { folder: f.out })
                : (out.state === 'absent' ? f.out : t('xml1.outExisting', { folder: f.out }));
            // X-Men Legends II as the builder found it: files that differ from a retail install are
            // used as they are (W_XML2_MODIFIED in the build).
            const modified = Number(xml2.modified_count) || 0;
            const firstModified = (xml2.modified && xml2.modified[0]) || '';
            const notices = [
                ...(modified ? [t('xml1.xml2Modified', { count: modified, first: firstModified })] : []),
                ...this.port().noticesOf(check.job).filter(notice => notice.code !== 'W_ISO_UNKNOWN_DUMP').map(notice => notice.text)
            ];
            const spaceDetail = space ? t(spaceOk ? 'xml1.spaceOk' : 'xml1.spaceLow', {
                need: bytes(space.need + (cacheSpace && cacheSpace.volume === space.volume ? cacheSpace.need : 0)),
                free: bytes(space.free), volume: space.volume
            }) : '';

            return `
                <div class="xml1-reqs">
                    ${row(true, iso.known ? t('xml1.discOk') : t('xml1.discUnknown'), f.iso)}
                    ${row(true, t('xml1.xml2Ok'), t('xml1.xml2Detail', { files: xml2.base_files || 0, language: xml2.language || '' }))}
                    ${row(!foreign, t('xml1.reqDestination'), outDetail)}
                    ${space ? row(spaceOk, t('xml1.spaceTitle'), spaceDetail) : ''}
                </div>
                ${notices.map(text => `<p class="xml1-note is-warn xml1-check-notice">${escapeHtml(text)}</p>`).join('')}
                <p class="xml1-estimate">${escapeHtml(t(estimate.first_build_s ? 'xml1.estimate' : 'xml1.estimateUnknown', { minutes, cores: estimate.cores || '?' }))}</p>
                <details class="xml1-advanced">
                    <summary>${escapeHtml(t('xml1.advanced'))}</summary>
                    ${this.optionHTML('movies', t('xml1.optMovies'), t('xml1.optMoviesBody'), f.movies)}
                    ${this.optionHTML('keepCache', t('xml1.optKeepCache'), t('xml1.optKeepCacheBody'), f.keepCache)}
                    ${LINK_BASE_SUPPORTED ? this.optionHTML('linkBase', t('xml1.optLinkBase'), t('xml1.optLinkBaseBody'), f.linkBase) : ''}
                </details>
                <div class="popup-actions">
                    <button type="button" class="btn-cancel" data-act="back">${escapeHtml(t('xml1.back'))}</button>
                    <button type="button" class="btn-apply" data-act="build" ${foreign || !spaceOk ? 'disabled' : ''}>${escapeHtml(t('xml1.build'))}</button>
                </div>`;
        }

        optionHTML(key, label, body, on) {
            return `
                <label class="xml1-option">
                    <span class="xml1-option-text"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(body)}</small></span>
                    <span class="ul-mod-toggle"><input type="checkbox" data-option="${key}" ${on ? 'checked' : ''}><span class="ul-mod-switch"></span></span>
                </label>`;
        }

        async startBuild() {
            const port = this.port();
            this.startError = null;
            const f = this.form;
            const started = await port.startBuild({ iso: f.iso.trim(), out: f.out.trim(), movies: f.movies, keepCache: f.keepCache, linkBase: f.linkBase });
            if (!started || !started.success) {
                this.check = { error: port.describe({ code: started && started.code, msg: started && started.error }) };
                this.step = 'check';
            } else {
                this.step = 'build';
            }
            this.render();
        }

        // ---- 3. building ----

        buildHTML() {
            const port = this.port();
            const job = port.build || { stages: [], overall: 0 };
            const percent = Math.max(0, Math.min(100, job.overall || 0));
            const eta = job.etaS > 0 ? t('xml1.eta', { time: GameUtils.formatDuration(job.etaS) }) : '';
            const stages = (job.stages || []).map(stage => {
                const running = stage.id === job.stage && stage.state === 'running';
                const note = stage.cached ? t('xml1.stageCached') : (running && job.total > 0 ? `${job.done}/${job.total} ${job.unit || ''}` : '');
                return `<li class="xml1-stage is-${escapeHtml(stage.state)}${stage.cached ? ' is-cached' : ''}">
                            <span class="xml1-stage-mark"></span>
                            <span class="xml1-stage-title">${escapeHtml(stage.title)}</span>
                            <span class="xml1-stage-note">${escapeHtml(note)}</span>
                        </li>`;
            }).join('');
            const cancelling = job.cancelRequested;
            return `
                <div class="xml1-progress">
                    <div class="xml1-progress-bar"><div class="xml1-progress-fill" style="width:${percent.toFixed(1)}%"></div></div>
                    <div class="xml1-progress-meta">
                        <span class="xml1-progress-message">${escapeHtml(cancelling ? t('xml1.cancelling') : port.progressMessage(job))}</span>
                        <span class="xml1-progress-numbers">${escapeHtml(eta)}${eta ? ' · ' : ''}${percent.toFixed(0)}%</span>
                    </div>
                </div>
                <ol class="xml1-stages">${stages || `<li class="xml1-stage is-running"><span class="xml1-stage-mark"></span><span class="xml1-stage-title">${escapeHtml(t('xml1.starting'))}</span></li>`}</ol>
                <p class="install-note">${escapeHtml(t('xml1.buildingNote'))}</p>
                <div class="popup-actions">
                    <button type="button" class="btn-uninstall" data-act="cancel-build" ${cancelling ? 'disabled' : ''}>${escapeHtml(t('xml1.cancelBuild'))}</button>
                    <button type="button" class="btn-apply" data-act="close">${escapeHtml(t('xml1.hide'))}</button>
                </div>`;
        }

        // ---- 4. finishing / ready / failure ----

        finishingHTML() {
            return `
                <div class="xml1-busy"><span class="xml1-spinner"></span>${escapeHtml(t('xml1.finishingBody'))}</div>`;
        }

        doneHTML() {
            const port = this.port();
            const s = port.status || {};
            const job = port.build || {};
            if (!s.isInstalled) {
                // Built, but the XML2 Fix could not be installed (offline, or its release unreachable).
                return `
                    <p class="xml1-note is-error">${escapeHtml(t('xml1.fixMissing'))}</p>
                    <div class="popup-actions">
                        <button type="button" class="btn-cancel" data-act="close">${escapeHtml(t('xml1.close'))}</button>
                        <button type="button" class="btn-apply" data-act="install-fix">${escapeHtml(t('xml1.installFix'))}</button>
                    </div>`;
            }
            return `
                <p class="xml1-ready">${escapeHtml(t('xml1.readyBody', { time: GameUtils.formatDuration(job.seconds || 0) || '-' }))}</p>
                ${port.noticesOf(job).map(notice => `<p class="xml1-note is-warn xml1-notice" data-code="${escapeHtml(notice.code)}">${escapeHtml(notice.text)}</p>`).join('')}
                <div class="popup-actions">
                    <button type="button" class="btn-cancel" data-act="open-folder">${escapeHtml(t('xml1.openFolder'))}</button>
                    <button type="button" class="btn-apply" data-act="play">${escapeHtml(t('common.play'))}</button>
                </div>`;
        }

        cancelledHTML() {
            return `
                <p class="install-note">${escapeHtml(t('xml1.cancelledBody'))}</p>
                <div class="popup-actions">
                    <button type="button" class="btn-cancel" data-act="close">${escapeHtml(t('xml1.close'))}</button>
                    <button type="button" class="btn-apply" data-act="resume">${escapeHtml(t('xml1.resume'))}</button>
                </div>`;
        }

        failedHTML() {
            const port = this.port();
            const job = port.build;
            const error = port.jobError(job);
            // Input problems send the player back to the choices; the rest can be resumed.
            const inputProblem = [2, 3, 4].includes(job && job.exitCode);
            return `
                ${this.errorHTML(error, job)}
                <div class="popup-actions">
                    <button type="button" class="btn-cancel" data-act="back">${escapeHtml(t('xml1.back'))}</button>
                    ${inputProblem ? '' : `<button type="button" class="btn-apply" data-act="resume">${escapeHtml(t('xml1.resume'))}</button>`}
                </div>`;
        }

        errorHTML(error, job) {
            const facts = (error.facts || []).map(fact => `<div class="xml1-error-fact">${escapeHtml(fact)}</div>`).join('');
            const tools = job ? `
                <div class="xml1-error-tools">
                    <button type="button" class="secondary-action xml1-small" data-act="copy-details">${escapeHtml(t('xml1.copyDetails'))}</button>
                    <button type="button" class="secondary-action xml1-small" data-act="open-log">${escapeHtml(t('xml1.openLog'))}</button>
                    <button type="button" class="secondary-action xml1-small" data-act="report">${escapeHtml(t('xml1.report'))}</button>
                </div>` : '';
            return `
                <div class="xml1-error" data-code="${escapeHtml(error.code)}">
                    <div class="xml1-error-title">${escapeHtml(error.title)}</div>
                    ${facts}
                    ${error.hint ? `<div class="xml1-error-hint">${escapeHtml(error.hint)}</div>` : ''}
                    <div class="xml1-error-code">${escapeHtml(error.code)}</div>
                    ${tools}
                </div>`;
        }

        // ---- events ----

        bind(content, step) {
            content.querySelectorAll('.xml1-input').forEach(input => {
                input.addEventListener('input', () => {
                    this.form[input.dataset.field] = input.value;
                    const apply = content.querySelector('[data-act="check"]');
                    if (apply) apply.disabled = !this.canCheck();
                });
                input.addEventListener('change', () => {
                    if (input.dataset.field === 'out') this.updateFreeSpace();
                });
            });
            content.querySelectorAll('[data-option]').forEach(box => {
                box.addEventListener('change', () => { this.form[box.dataset.option] = box.checked; });
            });
            content.querySelectorAll('[data-act]').forEach(element => {
                element.addEventListener('click', event => {
                    event.preventDefault();
                    this.act(element.dataset.act, step);
                });
            });
        }

        async act(action, step) {
            const port = this.port();
            switch (action) {
                case 'close':
                    this.hide();
                    break;
                case 'back':
                    this.step = 'requirements';
                    this.check = null;
                    this.render();
                    break;
                case 'setup-xml2':
                    this.hide();
                    if (typeof window.showSetupFlow === 'function') window.showSetupFlow('xml2');
                    break;
                case 'how-to-dump':
                    run('open-url', { url: port.DUMPING_URL });
                    break;
                case 'browse-iso': {
                    const file = await run('browse-file', {
                        title: t('xml1.pickDisc'),
                        filters: [{ name: t('xml1.discFilter'), pattern: '*.iso;*.xiso' }, { name: t('xml1.allFiles'), pattern: '*.*' }]
                    });
                    if (file) {
                        this.form.iso = file;
                        this.render();
                    }
                    break;
                }
                case 'builder-zip': {
                    const file = await run('browse-file', {
                        title: t('xml1.pickBuilderZip'),
                        filters: [{ name: t('xml1.zipFilter'), pattern: '*.zip' }, { name: t('xml1.allFiles'), pattern: '*.*' }]
                    });
                    if (!file) break;
                    this.zipNote = { ok: true, text: t('xml1.checkingBuilderZip') };
                    this.render();
                    const builder = await port.installBuilderZip(file);
                    if (builder.installed && builder.source === 'zip' && !builder.code) {
                        this.zipNote = { ok: true, text: t('xml1.builderFromZip', { version: builder.version }) };
                    } else {
                        const described = port.describe({ code: builder.code || 'L_BUILDER_ZIP_MISMATCH', msg: builder.error });
                        this.zipNote = { ok: false, text: `${described.title} ${described.hint}`.trim() };
                    }
                    this.render();
                    break;
                }
                case 'browse-out': {
                    const folder = await run('browse-folder');
                    if (folder) {
                        this.form.out = folder;
                        this.render();
                        this.updateFreeSpace();
                    }
                    break;
                }
                case 'check':
                    await this.runCheck();
                    break;
                case 'build':
                    await this.startBuild();
                    break;
                case 'cancel-build':
                    await port.confirmCancel();
                    this.render();
                    break;
                case 'resume': {
                    const started = await port.resume();
                    if (started && started.success) {
                        this.step = 'build';
                        this.render();
                    }
                    break;
                }
                case 'install-fix':
                    await port.installFix();
                    this.render();
                    break;
                case 'play':
                    this.hide();
                    if (typeof window.launchGame === 'function') window.launchGame(GAME);
                    break;
                case 'open-folder':
                    if (port.status && port.status.install) run('open-folder', { path: port.status.install });
                    break;
                case 'copy-details':
                    await port.copyDetails(port.build || (this.check && this.check.job));
                    break;
                case 'open-log':
                    if (!await port.openLog()) window.showToast(t('xml1.noLog'), 'info');
                    break;
                case 'report':
                    await port.report(port.build || (this.check && this.check.job));
                    break;
                default:
                    break;
            }
        }
    }

    // Uninstall (section 4.6): what to delete, then the builder's clean and the launcher's own.
    async function showUninstall() {
        const port = window.Xml1Port;
        await port.refresh();
        let sizes = {};
        try {
            sizes = await run('xml1-sizes') || {};
        } catch (_) { /* sizes are only shown */ }
        const cacheBytes = sizes.cache;
        const gameBytes = sizes.game;

        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.className = 'component-selection-backdrop xml1-uninstall-backdrop';
            backdrop.innerHTML = `
                <div class="component-selection-popup xml1-uninstall">
                    <div class="popup-header">
                        <h3>${escapeHtml(t('xml1.uninstallTitle'))}</h3>
                        <button class="popup-close" type="button"></button>
                    </div>
                    <div class="popup-content">
                        <label class="xml1-check"><input type="checkbox" data-choice="deleteGame" checked>
                            <span>${escapeHtml(gameBytes ? t('xml1.uninstallDeleteGameSize', { size: bytes(gameBytes) }) : t('xml1.uninstallDeleteGame'))}</span></label>
                        <label class="xml1-check is-sub"><input type="checkbox" data-choice="mods">
                            <span>${escapeHtml(t('xml1.uninstallMods'))}</span></label>
                        <label class="xml1-check"><input type="checkbox" data-choice="cache" checked>
                            <span>${escapeHtml(cacheBytes != null ? t('xml1.uninstallCacheSize', { size: bytes(cacheBytes) }) : t('xml1.uninstallCache'))}</span></label>
                        <p class="install-note">${escapeHtml(t('xml1.uninstallNote'))}</p>
                        <div class="popup-actions">
                            <button type="button" class="btn-cancel" data-act="cancel">${escapeHtml(t('common.cancel'))}</button>
                            <button type="button" class="btn-uninstall" data-act="uninstall">${escapeHtml(t('common.uninstall'))}</button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            backdrop.style.display = 'flex';
            requestAnimationFrame(() => {
                backdrop.classList.add('active');
                backdrop.querySelector('.xml1-uninstall').classList.add('active');
            });

            const deleteGame = backdrop.querySelector('[data-choice="deleteGame"]');
            const mods = backdrop.querySelector('[data-choice="mods"]');
            const sync = () => {
                mods.disabled = !deleteGame.checked;
                if (!deleteGame.checked) mods.checked = false;
            };
            deleteGame.addEventListener('change', sync);
            sync();

            const close = value => {
                backdrop.remove();
                resolve(value);
            };
            backdrop.querySelector('.popup-close').addEventListener('click', () => close(false));
            backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
            backdrop.querySelector('[data-act="uninstall"]').addEventListener('click', () => {
                const choices = {
                    deleteGame: deleteGame.checked,
                    mods: mods.checked,
                    cache: backdrop.querySelector('[data-choice="cache"]').checked
                };
                close(true);
                port.uninstall(choices);
            });
        });
    }

    const popup = new Xml1SetupPopup();
    window.Xml1Setup = {
        show: () => popup.show(),
        hide: () => popup.hide(),
        isOpen: () => popup.isOpen(),
        showUninstall
    };
})();
