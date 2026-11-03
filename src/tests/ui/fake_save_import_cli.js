'use strict';
// Invented JSONL converter for headless host and UI tests. Never reads or writes
// save files. The admitted scenario exercises a future protocol, not release readiness.
const HASH = 'a'.repeat(64), TOKEN = 'b'.repeat(64), OUTPUT = 'c'.repeat(64), TXN = 'd'.repeat(32);
const changes = [{ field: 'world', source: 'Current zone', target: 'Checkpoint start', reason: 'Enemies and fog reset.' }];
function reply(mode, request = {}, scenario = 'gated') {
    const caps = { schema: 1, extracted_folders: true, hdd_images: true, writer_lock: 'lc-save-writer/1', recomp_extensions: false,
        player_install: scenario === 'admitted' || scenario === 'changed', merge_unlocks: false,
        undo: scenario === 'admitted', backup_policy: 'retained campaign copy and report' };
    const source = { schema: 1, source_sha256: HASH, decoder: 'retail-v1', description: 'Invented campaign',
        heroes: [{ name: 'wolverine', level: 12, experience: 1200, unlocked: true }, { name: 'storm', level: 9, unlocked: false }],
        progress: { zone: 'invented_hub', mission_id: 7, party: ['wolverine'] }, signature_message: 'Xbox signature not checked.' };
    const error = (code, msg, detail = {}) => [{ ev: 'hello', v: 1, builder: 'test-fixture', content_version: 1 }, { ev: 'error', stage: 'import', code, msg, detail }, { ev: 'result', ok: false, exit: 2 }];
    const report = { schema: 1, source_sha256: HASH, preview_token: TOKEN, output_sha256: OUTPUT, slot: request.slot,
        checkpoint: 'Invented mansion checkpoint', heroes: source.heroes, progress: source.progress, signature_message: source.signature_message,
        imported: [{ field: 'tech_bits', value: 12345 }], approximated: changes,
        skipped: [{ field: 'trivia', source: 'Original answers', reason: 'Unresolved trivia state cannot carry over.' }],
        player_use_validated: caps.player_install, validation: 'Synthetic protocol fixture only.' };
    if (scenario.startsWith('recomp')) {
        source.decoder = 'recomp-chr-v6'; source.source_container = { kind: 'recomp' };
        report.source_container = { kind: scenario === 'recomp-wrong-kind' ? 'extracted-folder' : 'recomp' };
        report.skipped.push({ field: 'stash', source: 'recomp stash', reason: 'Stash cannot carry over.' });
    }
    if (scenario.startsWith('hdd')) {
        source.source_container = { kind: 'hdd-image', campaign: request.campaign || 'E:/UDATA/4156001e/Campaign A', image_format: 'qcow2', image_snapshot: HASH };
        report.source_container = { ...source.source_container };
        if (scenario === 'hdd-wrong-campaign') report.source_container.campaign = 'E:/UDATA/4156001e/Other';
    }
    let result;
    if (mode === 'inspect') {
        if (scenario === 'hdd-encrypted') return error('E_XML1_DISK_VERSION', 'This HDD image format or feature is not supported.', { reason: 'Encrypted QCOW2 is unsupported.' });
        if (scenario === 'hdd-unknown') return error('E_XML1_DISK_VERSION', 'This HDD image format or feature is not supported.', { reason: 'Unknown disk format.' });
        if (scenario === 'hdd-corrupt') return error('E_XML1_DISK_DAMAGED', 'This HDD image has invalid or incomplete disk structures.', { reason: 'Truncated QCOW2 metadata.' });
        if (scenario === 'hdd-locked') return error('E_XML1_BUSY', 'Close the game and any other save importer before importing a campaign.');
        if (scenario === 'recomp-version') return error('E_XML1_RECOMP_VERSION', 'Unsupported recomp CHR version.');
        if (scenario.startsWith('hdd')) {
            const multi = scenario === 'hdd-multiple' && !request.campaign;
            result = { imported: false, candidates: (scenario === 'hdd-multiple' ? ['E:/UDATA/4156001e/Campaign A', 'E:/UDATA/4156001e/Campaign B'] : [source.source_container.campaign]).map(campaign => ({ folder: request.source, label: campaign, campaign })), source_report: multi ? null : source };
        } else {
        const multi = ['multiple', 'recomp-multiple'].includes(scenario) && !/[\\/]campaign[AB]$/.test(String(request.source));
        result = { imported: false, candidates: multi
            ? [{ folder: request.source + '\\campaignA', label: 'Campaign A' }, { folder: request.source + '\\campaignB', label: 'Campaign B' }]
            : [{ folder: request.source, label: '.' }], source_report: multi ? null : source };
        }
    } else if (mode === 'slots') {
        result = { imported: false, slots: Array.from({ length: 10 }, (_, slot) => ({ slot, occupied: slot === 1 || slot === 2 })), imports: [] };
    } else if (mode === 'preview') {
        if (scenario === 'inferred' && !request.allowInferred) return error('E_XML1_INFERRED', 'Review the experimental mappings.', { approximated: changes, skipped: report.skipped });
        if (scenario === 'refused') return error('E_XML1_CONTEXT', '<script>alert(1)</script> Unsupported checkpoint.');
        if (scenario === 'wrong-source') report.source_sha256 = 'f'.repeat(64);
        if (scenario === 'wrong-output') report.output_sha256 = 'invalid';
        result = { imported: false, dry_run: true, import_report: report };
    } else if (mode === 'apply') {
        if (scenario === 'changed') return error('E_XML1_CHANGED', 'The source changed.');
        result = { imported: true, dry_run: false, slot: request.slot, transaction_id: TXN, preview_token: request.previewToken,
            output_sha256: OUTPUT, backup: request.saveDir + '\\.xml1-imports\\' + TXN + '\\campaign.lcsave',
            report: request.saveDir + '\\.xml1-imports\\' + TXN + '\\report.json', checkpoint: report.checkpoint };
    } else if (mode === 'undo') {
        result = { undone: true, transaction_id: request.transactionId, slot: request.undoSlot,
            retained: request.saveDir + '\\.xml1-imports\\' + TXN + '\\undone.lcsave' };
    } else return error('E_USAGE', 'Unknown operation.');
    return [{ ev: 'hello', v: 1, builder: 'test-fixture', content_version: 1 },
        { ev: 'result', ok: true, exit: 0, capabilities: caps, ...result }];
}
if (require.main === module) {
    const args = process.argv.slice(2);
    const value = flag => args[args.indexOf(flag) + 1];
    const mode = args.includes('--inspect-source') ? 'inspect' : args.includes('--list-slots') ? 'slots' :
        args.includes('--undo-import') ? 'undo' : args.includes('--dry-run') ? 'preview' : 'apply';
    const scenario = args.includes('--fake-scenario') ? value('--fake-scenario') : 'gated';
    const valuedFlags = new Set(['--events', '--build', '--save-dir', '--slot', '--preview-token', '--undo-import', '--fake-scenario', '--campaign', '--source-kind']);
    let source = '';
    for (let i = args.indexOf('import-xml1-save') + 1; i < args.length; ++i) {
        if (valuedFlags.has(args[i])) { ++i; continue; }
        if (!args[i].startsWith('--')) { source = args[i]; break; }
    }
    const request = { source, campaign: args.includes('--campaign') ? value('--campaign') : '', slot: Number(value('--slot')), saveDir: value('--save-dir'),
        sourceKind: args.includes('--source-kind') ? value('--source-kind') : 'auto',
        previewToken: value('--preview-token'), transactionId: value('--undo-import'), allowInferred: args.includes('--allow-inferred') };
    const emit = event => process.stdout.write(JSON.stringify({ t: 0, ...event }) + '\n');
    if (scenario === 'wait') {
        emit({ ev: 'hello', v: 1, builder: 'test-fixture', content_version: 1 });
        emit({ ev: 'log', msg: 'Waiting for cancellation.' });
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', text => { if (text.includes('cancel')) { emit({ ev: 'result', ok: false, exit: 5, cancelled: true }); process.exitCode = 5; process.stdin.destroy(); } });
    } else {
        const events = reply(mode, request, scenario);
        if (scenario.startsWith('recomp')) events.at(-1).received_source_kind = request.sourceKind;
        if (scenario !== 'no-result') events.forEach(event => emit(event.ev === 'result' ? { ...event, test_idle: require('node:os').getPriority() === require('node:os').constants.priority.PRIORITY_LOW } : event));
        process.exitCode = scenario === 'mismatch' ? 3 : (events.at(-1).exit || 0);
    }
}
module.exports = { reply, HASH, TOKEN, OUTPUT, TXN };
