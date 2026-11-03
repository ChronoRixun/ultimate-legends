# Incremental character models: integration checks

`node src/tests/ui/run.js` exercises the real page scripts against the fake backend. The models
tests cover missing heroes, changed costumes/tiers, stale/damaged folders, unchanged heroes,
appearance changes, offline updates, hero counts versus converter calls, and cancellation from
the page and Downloads. The C++ host suite covers validated repeated `--hero` arguments.

Run `python tools/dev/models_incremental_smoke.py --work-folder <absolute scratch folder>` for a
headless disk/protocol check using the repository's fake tool: new hero, changed costume, unchanged
hero and unrelated mod hashes/load-order bytes preserved, and cancellation during conversion.
It never starts a game or launcher and makes no network requests.

## Launcher click-through before release

Run the repository's existing `tools/dev/models_cdp.py` on an isolated Debug launcher with the
fake tool, following its setup instructions. That existing suite includes local HTTP and an
optional real-manifest check; it was not run in this offline workspace task. Add these scenarios
to the release pass, with screenshots of the page and Downloads:

1. Install a subset of an appearance. Reopen it with a plan containing additional heroes. Both
   **Install the new options** and **Rebuild** must be available. Incremental install sends only
   the added heroes as repeated `--hero`; it never removes the installed group or switches Off.
   Hash existing hero folders and unrelated mods and compare load-order lines before/after.
2. Change one costume, then make an owned MUA tier available. Each incremental run selects only
   heroes whose planned tier/source differs. After success no unchanged hero is offered again.
   Selecting another appearance uses the full Apply path. Rebuild still sends no hero filter.
3. Verify a stale or damaged folder: the incremental selection includes its heroes, while intact
   folders remain untouched. A disabled group, running game or active port build cannot update.
4. Replay X1 API-1 refinement `progress` events. Check the current hero, tier, stage, call of max,
   loss and elapsed time on both the page and Downloads. The heroes-completed counter must keep
   its own total and not jump to the optimizer call limit. Changing hero/tier/stage clears the old
   refinement details. Older tools that send only hero progress must still work.
5. Cancel an incremental conversion from each surface. Both show Cancelling, wait until the job
   exits, reload status/plan and verify. Compare existing model folders and load-order bytes;
   retry must remain available. No conversion children may survive, and the game folder hold must
   stay in place until the tool exits. Check Cancel declined as well.
6. Check an offline owned-source update while an unchanged community hero is not cached: the
   incremental action works, while full Rebuild remains subject to its download requirements.
   An update that itself requires a missing download stays disabled.
7. Check keyboard/controller navigation, focus after redraw, display scaling and long translated
   labels. Inspect Recent's incremental title, cancellation and success outcomes.

## Integrated beta.4 contract

The consumer is tested with X1's actual fields: `stage: "refine_bind"`, `call`, `max_calls`, `done`, `total`, `elapsed`, `loss`, `best_loss`, `max_seconds` and optional termination reason. `done`/`total` on that staged event do not change hero progress. Accepted cache hits and changed-input refits show their reason on both surfaces.

The launcher signals a unique `LEGENDS_MODELS_CANCEL` file for beta.4+ builds. The tool checks during conversion and before publication, kills/reaps its engine and exits 130. Once publication starts it finishes the whole group and load-order update and returns its actual result. Keep the folder reservation through process exit. Older tools retain kill cancellation. Closing the launcher/externally killing a publishing process is outside the cooperative guarantee.

For the release click-through, additionally cancel during live real refinement and verify no engine survives and existing folder/load-order hashes match. Then request cancellation after the publish stage starts: expect a complete verified installation and its actual success/partial result, rather than a half-published folder. Verify this from both page and Downloads, including a confirmation that resolves after the job has finished. Reopen the page and retry a cancelled conversion. Show the `owner_accepted` explanation for exact accepted reuse and an `inputs_changed` explanation for a fresh refit.

Offline automated evidence and artifact hashes are in the integration work folder REPORT.md; native launcher rendering, navigation and visual acceptance remain release click-through checks. No version or release identity is assigned by these source changes.
