// Offline import wizard. JSONL work stays alive across page redraws; only a
// successful apply result may say Imported. Source discovery and previews write nothing.
(function () {
    'use strict';
    const run = (command, payload) => window.executeCommand(command, payload);
    const esc = value => GameUtils.escapeHtml(String(value == null ? '' : value));
    const t = (key, values) => window.LauncherI18n.t(`saveImport.${key}`, values);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
    const state = {
        opened: false, sourceType: 'xbox', source: '', campaign: '', retryMode: null, saveDir: '', slot: '', candidates: [],
        sourceReport: null, report: null, slots: [], imports: [], capabilities: {},
        approximated: [], skipped: [], allowInferred: false, mergeUnlocks: false,
        busy: false, confirming: false, id: null, cancelRequested: false,
        error: '', message: '', installed: null, undone: null
    };
    const host = () => document.getElementById('xml1-save-import');
    const locked = () => state.busy || state.confirming;
    const emptySlot = () => Number.isInteger(state.slot) && state.slots.some(row => row.slot === state.slot && row.occupied === false);
    const canPreview = () => !locked() && !state.retryMode && state.sourceReport && state.source && state.saveDir && emptySlot();
    const canApply = () => canPreview() && state.report && !state.installed &&
        state.capabilities.player_install === true && state.report.player_use_validated === true &&
        state.report.slot === state.slot && hex(state.report.preview_token, 64) && hex(state.report.output_sha256, 64);

    function invalidate() {
        state.report = null;
        state.retryMode = null;
        state.installed = null;
        state.undone = null;
        state.error = '';
        state.message = '';
    }
    function words(value) {
        return String(value).replace(/[_\.]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    }
    function describe(value) {
        if (value == null) return '-';
        if (Array.isArray(value)) return value.map(describe).join(', ');
        if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${words(key)}: ${describe(item)}`).join('; ');
        return String(value);
    }
    function list(rows, change) {
        if (!Array.isArray(rows) || !rows.length) return '';
        return `<ul>${rows.map(row => `<li><strong>${esc(words(row.field || row.code || ''))}</strong>: ${esc(change
            ? `${describe(row.source)} → ${describe(row.target)}. ${row.reason || ''}`
            : `${describe(row.value === undefined ? row.source : row.value)}${row.reason ? '. ' + row.reason : ''}`)}</li>`).join('')}</ul>`;
    }
    function heroes(report) {
        if (!report || !Array.isArray(report.heroes)) return '';
        return `<h4>${esc(t('heroes'))}</h4><table class="xml1-import-heroes"><thead><tr><th>${esc(t('hero'))}</th><th>${esc(t('level'))}</th><th>${esc(t('unlock'))}</th></tr></thead>
            <tbody>${report.heroes.map(hero => `<tr><td>${esc(words(hero.name))}</td><td>${esc(hero.level)}</td><td>${esc(t(hero.unlocked ? 'yes' : 'no'))}</td></tr>`).join('')}</tbody></table>`;
    }
    function button(action, label, disabled = false) {
        return `<button type="button" class="secondary-action xml1-small" data-import-act="${action}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
    }
    function captureFocus() {
        const focused = document.activeElement;
        const element = host();
        return focused && element && focused.closest && focused.closest('#xml1-save-import') === element
            ? { id: focused.id, action: focused.dataset.importAct } : null;
    }
    function notify() { window.dispatchEvent(new CustomEvent('ul-xml1-changed')); }
    function mount(savedFocus) {
        const focus = savedFocus || captureFocus();
        const element = host();
        if (!element) return;
        element.hidden = !state.opened;
        if (!state.opened) { element.innerHTML = ''; return; }
        const report = state.report;
        const facts = report || state.sourceReport;
        const disabled = locked() ? 'disabled' : '';
        const options = state.slots.map(row => `<option value="${esc(row.slot)}" ${row.occupied ? 'disabled' : ''} ${row.slot === state.slot ? 'selected' : ''}>${esc(t(row.occupied ? 'slotOccupied' : 'slotEmpty', { slot: row.slot }))}</option>`).join('');
        element.innerHTML = `<section class="ul-display xml1-import" aria-label="${esc(t('title'))}">
            <h3>${esc(t('title'))}</h3><p class="ul-display-intro">${esc(t('intro'))}</p>
            ${state.capabilities.player_install !== true ? `<div class="xml1-note is-warn">${esc(t('gated'))}</div>` : ''}
            <label>${esc(t('sourceType'))}<select id="xml1-import-source-type" ${disabled}>
                ${['xbox', 'hdd', 'recomp'].map(kind => `<option value="${kind}" ${state.sourceType === kind ? 'selected' : ''}>${esc(t(kind))}</option>`).join('')}
            </select></label>
            <div class="xml1-actions">${button('source', t('chooseSource'), locked())}</div>
            ${state.sourceType === 'recomp' ? `<p class="xml1-note">${esc(t('recompHelp'))}</p>` : ''}
            <p class="xml1-import-path">${esc(t('source'))}: ${esc(state.source)}</p>
            ${state.campaign ? `<p class="xml1-import-path">${esc(t('campaign'))}: ${esc(state.campaign)}</p>` : ''}
            ${state.candidates.length > 1 ? `<label>${esc(t('campaign'))}<select id="xml1-import-campaign" ${disabled}><option value="">${esc(t('chooseCampaign'))}</option>${state.candidates.map((row, index) => `<option value="${index}" ${row.campaign && row.campaign === state.campaign ? 'selected' : ''}>${esc(row.label)}</option>`).join('')}</select></label>` : ''}
            <div class="xml1-actions">${button('target', t('chooseTarget'), locked())}${button('scan', t('scan'), locked() || !state.saveDir)}</div>
            <p class="xml1-import-path">${esc(t('target'))}: ${esc(state.saveDir)}</p><p>${esc(t('targetHelp'))}</p>
            <label>${esc(t('slot'))}<select id="xml1-import-slot" ${disabled || (!state.slots.length ? 'disabled' : '')}><option value="">${esc(t('chooseSlot'))}</option>${options}</select></label>
            <label><input type="checkbox" id="xml1-import-merge" ${state.mergeUnlocks ? 'checked' : ''} ${disabled || (state.capabilities.merge_unlocks !== true ? 'disabled' : '')}> ${esc(t('merge'))}</label>
            ${state.capabilities.merge_unlocks !== true ? `<p>${esc(t('mergeUnavailable'))}</p>` : ''}
            ${state.approximated.length ? `<div><h4>${esc(t('changed'))}</h4>${list(state.approximated, true)}${list(state.skipped, false)}<label><input type="checkbox" id="xml1-import-inferred" ${state.allowInferred ? 'checked' : ''} ${disabled}> ${esc(t('inferred'))}</label></div>` : ''}
            ${facts ? `<h4>${esc(t('sourceFacts'))}</h4>${!report ? `<p>${esc(t('provisional'))}</p>` : ''}${heroes(facts)}<p>${esc(t('progress'))}: ${esc(describe(facts.progress))}</p><p>${esc(facts.signature_message || t('signature'))}</p>` : ''}
            ${report ? `<div class="xml1-import-preview"><h4>${esc(t('continue', { checkpoint: report.checkpoint }))}</h4><p>${esc(t('previewOnly'))}</p><p>${esc(t('worldReset'))}</p>
                <h4>${esc(t('preserved'))}</h4>${list(report.imported, false)}<h4>${esc(t('changed'))}</h4>${list(report.approximated, true)}<h4>${esc(t('skipped'))}</h4>${list(report.skipped, false)}</div>` : ''}
            ${state.installed ? `<div class="xml1-note">${esc(t('installed', { slot: state.installed.slot }))}<p>${esc(t('backup'))}: ${esc(state.installed.backup)}</p><p>${esc(t('report'))}: ${esc(state.installed.report)}</p></div>` : ''}
            ${state.undone ? `<div class="xml1-note">${esc(t('undone', { slot: state.undone.slot }))}</div>` : ''}
            <div role="status" aria-live="polite">${esc(state.cancelRequested ? t('cancelling') : state.message)}</div>
            ${state.retryMode ? `<div class="xml1-note is-warn">${esc(t('writerWaiting'))}${button('retry', t('retry'), locked())}</div>` : ''}
            ${state.error ? `<div role="alert" class="xml1-note is-error">${esc(state.error)}</div>` : ''}
            <div class="xml1-actions">${button('preview', t('preview'), !canPreview())}${button('apply', t('import', { slot: state.slot === '' ? '-' : state.slot }), !canApply())}${state.busy ? button('cancel', t('cancel'), state.cancelRequested) : button('close', t('close'), state.confirming)}</div>
            <h4>${esc(t('history'))}</h4>${!state.imports.length ? `<p>${esc(t('noHistory'))}</p>` : state.imports.map((row, index) => `<div class="xml1-import-history"><p>${esc(t('slot'))} ${esc(row.slot)}: ${esc(row.checkpoint)}</p><p>${esc(t('backup'))}: ${esc(row.backup)}</p><p>${esc(t('report'))}: ${esc(row.report)}</p>${button(`undo-${index}`, t('undo'), locked() || !row.undo_available || state.capabilities.undo !== true)}</div>`).join('')}
            <p>${esc(t('undoUnavailable'))}</p>
        </section>`;
        element.querySelectorAll('[data-import-act]').forEach(control => control.addEventListener('click', () => act(control.dataset.importAct).catch(error => { state.error = String(error.message || error); mount(); })));
        const bind = (id, fn) => { const control = document.getElementById(id); if (control) control.addEventListener('change', () => { if (!locked()) fn(control); }); };
        bind('xml1-import-source-type', control => {
            if (!['xbox', 'hdd', 'recomp'].includes(control.value)) return;
            invalidate(); state.sourceType = control.value; state.source = ''; state.campaign = ''; state.sourceReport = null;
            state.candidates = []; state.approximated = []; state.skipped = []; state.allowInferred = false; mount();
        });
        bind('xml1-import-campaign', control => {
            const candidate = state.candidates[Number(control.value)];
            if (control.value !== '' && candidate) {
                invalidate(); state.sourceReport = null; state.approximated = []; state.skipped = []; state.allowInferred = false;
                if (state.sourceType !== 'hdd') state.source = candidate.folder;
                state.campaign = candidate.campaign || ''; job('inspect');
            } else if (control.value === '') { invalidate(); state.sourceReport = null; state.campaign = ''; mount(); }
        });
        bind('xml1-import-slot', control => { invalidate(); state.slot = control.value === '' ? '' : Number(control.value); mount(); });
        bind('xml1-import-merge', control => { invalidate(); state.mergeUnlocks = state.capabilities.merge_unlocks === true && control.checked; mount(); });
        bind('xml1-import-inferred', control => { invalidate(); state.allowInferred = control.checked; mount(); });
        // Enhance synchronously before restoring focus: the MutationObserver also
        // covers redraws, but its callback runs after this function returns.
        if (window.LauncherDropdowns) window.LauncherDropdowns.enhance(element);
        if (focus) {
            const next = focus.id ? document.getElementById(focus.id) : element.querySelector(`[data-import-act="${focus.action}"]`);
            const fallback = (state.busy ? ['cancel'] : ['preview', 'target', 'source', 'close'])
                .map(action => element.querySelector(`[data-import-act="${action}"]`)).find(control => control && !control.disabled);
            if (next && !next.disabled) next.focus();
            else if (fallback && !fallback.disabled) fallback.focus();
        }
    }

    function failure(error, mode) {
        state.report = null;
        state.message = '';
        const code = error && error.code;
        state.error = code === 'E_XML1_CHANGED' ? t('changedInput') : (error && (error.msg || error.error)) || t('error');
        if (['E_XML1_DISK_VERSION', 'E_XML1_DISK_DAMAGED'].includes(code) && typeof error.detail?.reason === 'string') state.error += ' ' + error.detail.reason;
        if (['E_XML1_BUSY', 'L_GAME_RUNNING'].includes(code) && ['inspect', 'slots', 'preview'].includes(mode)) state.retryMode = mode;
        if (code === 'E_XML1_INFERRED' && error.detail) {
            state.approximated = Array.isArray(error.detail.approximated) ? error.detail.approximated : [];
            state.skipped = Array.isArray(error.detail.skipped) ? error.detail.skipped : [];
            state.message = t('retryPreview');
        }
        if (code === 'E_XML1_CHANGED') state.sourceReport = null;
    }
    function accept(mode, snapshot, sent) {
        const result = snapshot.result;
        if (snapshot.exitCode === 5 || (result && result.cancelled === true)) {
            state.report = null; state.message = t('cancelled'); return;
        }
        if (snapshot.exitCode !== 0 || !result || result.ok !== true || result.exit !== 0) {
            failure((snapshot.errors || []).slice(-1)[0] || { msg: t('protocol') }, mode); return;
        }
        if (result.capabilities && result.capabilities.schema === 1) state.capabilities = result.capabilities;
        if (mode === 'inspect') {
            if (!Array.isArray(result.candidates) || result.imported !== false || !result.candidates.every(row =>
                row && typeof row.folder === 'string' && typeof row.label === 'string' &&
                (state.sourceType !== 'hdd' || (row.folder === state.source && typeof row.campaign === 'string' && row.campaign)))) return failure({ msg: t('protocol') });
            state.candidates = result.candidates;
            state.sourceReport = result.source_report || null;
            if (state.sourceType === 'recomp' && state.sourceReport && state.sourceReport.source_container?.kind !== 'recomp') {
                state.sourceReport = null; return failure({ msg: t('protocol') });
            }
            if (state.sourceType === 'hdd' && state.sourceReport) {
                const selected = result.candidates.find(row => row.campaign === state.sourceReport.source_container?.campaign);
                if (state.sourceReport.source_container?.kind !== 'hdd-image' || !selected || (state.campaign && selected.campaign !== state.campaign)) { state.sourceReport = null; return failure({ msg: t('protocol') }); }
                state.campaign = selected.campaign;
            }
        } else if (mode === 'slots') {
            if (!Array.isArray(result.slots) || result.slots.length !== 10 || !Array.isArray(result.imports) || result.imported !== false ||
                !result.slots.every((row, i) => row.slot === i && typeof row.occupied === 'boolean')) return failure({ msg: t('protocol') });
            state.slots = result.slots; state.imports = result.imports;
            if (!emptySlot()) state.slot = '';
        } else if (mode === 'preview') {
            const report = result.import_report;
            if (result.dry_run !== true || result.imported !== false || !report || report.schema !== 1 ||
                report.slot !== state.slot || !hex(report.preview_token, 64) || !hex(report.output_sha256, 64) ||
                !state.sourceReport || report.source_sha256 !== state.sourceReport.source_sha256 ||
                (state.sourceType === 'recomp' && report.source_container?.kind !== 'recomp') ||
                (state.sourceType === 'hdd' && (report.source_container?.kind !== 'hdd-image' || report.source_container?.campaign !== state.campaign))) return failure({ msg: t('protocol') });
            state.report = report; state.approximated = []; state.skipped = []; state.message = t('previewOnly');
        } else if (mode === 'apply') {
            if (result.imported !== true || result.dry_run === true || result.slot !== state.slot ||
                result.preview_token !== sent.previewToken || result.output_sha256 !== sent.outputSha256 ||
                !hex(result.transaction_id, 32) || typeof result.backup !== 'string' || !result.backup || typeof result.report !== 'string' || !result.report) return failure({ msg: t('protocol') });
            state.installed = result; state.report = null;
            state.slots = state.slots.map(row => row.slot === result.slot ? { slot: row.slot, occupied: true } : row);
            state.imports.push({ transaction_id: result.transaction_id, slot: result.slot, backup: result.backup, report: result.report, checkpoint: result.checkpoint, undo_available: true });
            state.message = '';
        } else if (mode === 'undo') {
            if (result.undone !== true || result.transaction_id !== sent.transactionId || result.slot !== sent.undoSlot || typeof result.retained !== 'string' || !result.retained) return failure({ msg: t('protocol') });
            state.undone = result; state.installed = null; state.report = null;
            state.imports = state.imports.map(row => row.transaction_id === result.transaction_id ? Object.assign({}, row, { undo_available: false }) : row);
            state.slots = []; state.slot = ''; // refresh before selecting another destination
        }
    }
    async function job(mode, extra = {}) {
        if (state.busy) return;
        const focus = captureFocus();
        state.busy = true; state.id = null; state.cancelRequested = false; state.retryMode = null; state.error = ''; state.message = t('busy');
        if (mode !== 'apply') state.report = null;
        if (mode === 'inspect') state.sourceReport = null;
        mount(); notify();
        try {
            const started = await run('xml1-import-start', Object.assign({ mode, source: state.source, campaign: state.campaign, saveDir: state.saveDir,
                sourceKind: state.sourceType === 'recomp' ? 'recomp' : 'auto',
                slot: state.slot, mergeUnlocks: state.mergeUnlocks, allowInferred: state.allowInferred }, extra));
            if (!started || started.success !== true || !Number.isInteger(started.id)) { failure(started, mode); return; }
            state.id = started.id;
            if (state.cancelRequested) await sendCancel();
            for (;;) {
                let snapshot;
                try { snapshot = await run('get-xml1-job', { id: state.id }); } catch (_) { /* retain the job and retry; never start a second one */ }
                if (snapshot && snapshot.id === state.id && snapshot.finished === true && snapshot.active === false) { state.message = ''; accept(mode, snapshot, extra); break; }
                if (!snapshot) state.message = t('statusLost');
                else if (snapshot.id === state.id) state.message = snapshot.message || t('busy');
                mount();
                await sleep(250);
            }
        } catch (error) { failure({ msg: String(error.message || error) }); }
        finally {
            // While reading, focus can move to Cancel. Return to the initiating
            // control on exit unless the player moved outside this panel.
            const restore = captureFocus() && focus;
            state.busy = false; state.id = null; state.cancelRequested = false; mount(restore); notify();
        }
    }
    async function sendCancel() {
        try {
            const accepted = await run('xml1-import-cancel', { id: state.id });
            if (accepted !== true) throw new Error('Cancellation was not accepted.');
        } catch (_) {
            state.cancelRequested = false; state.error = t('statusLost'); mount();
        }
    }
    async function act(action) {
        if (action === 'cancel') {
            if (!state.busy || state.cancelRequested) return;
            state.cancelRequested = true; mount();
            if (state.id !== null) await sendCancel();
            return;
        }
        if (locked()) return;
        if (action === 'close') { state.opened = false; mount(); return; }
        if (action === 'retry' && state.retryMode) { await job(state.retryMode); return; }
        if (action === 'source') {
            state.confirming = true; mount();
            let path;
            try {
                path = await run(state.sourceType === 'hdd' ? 'browse-file' : 'browse-folder', state.sourceType === 'hdd'
                    ? { title: t('chooseSource'), filters: [{ name: 'xemu HDD image', pattern: '*.qcow2;*.raw;*.img;*.bin;*.hdd' }, { name: t('allFiles'), pattern: '*.*' }] } : null);
            } finally { state.confirming = false; mount(); }
            if (!path) return;
            invalidate(); state.source = path; state.campaign = ''; state.sourceReport = null; state.candidates = []; state.approximated = []; state.skipped = []; state.allowInferred = false;
            await job('inspect');
        } else if (action === 'target') {
            state.confirming = true; mount();
            let path;
            try { path = await run('browse-folder'); } finally { state.confirming = false; mount(); }
            if (!path) return;
            invalidate(); state.saveDir = path; state.slots = []; state.slot = ''; state.imports = []; await job('slots');
        } else if (action === 'scan' && state.saveDir) {
            invalidate(); await job('slots');
        } else if (action === 'preview' && canPreview()) {
            await job('preview');
        } else if (action === 'apply' && canApply()) {
            const report = state.report;
            state.confirming = true; mount();
            let choice;
            try { choice = await window.showMessageBox(t('confirmTitle'), esc(t('confirmBody', { checkpoint: report.checkpoint, slot: state.slot })), [t('close'), t('import', { slot: state.slot })]); }
            finally { state.confirming = false; mount(); }
            if (choice === 1 && state.report === report && canApply()) await job('apply', { confirmed: true, previewToken: report.preview_token, outputSha256: report.output_sha256 });
        } else if (action.startsWith('undo-')) {
            const row = state.imports[Number(action.slice(5))];
            if (!row || !row.undo_available || state.capabilities.undo !== true) return;
            state.confirming = true; mount();
            let choice;
            try { choice = await window.showMessageBox(t('undoTitle'), esc(t('undoBody', { slot: row.slot })), [t('close'), t('undo')]); }
            finally { state.confirming = false; mount(); }
            if (choice === 1) await job('undo', { confirmed: true, transactionId: row.transaction_id, undoSlot: row.slot });
        }
    }
    window.Xml1SaveImport = {
        open() { state.opened = true; mount(); const first = document.getElementById('xml1-import-source-type'); if (first) first.focus(); },
        mount, captureFocus, isBusy: locked
    };
})();
