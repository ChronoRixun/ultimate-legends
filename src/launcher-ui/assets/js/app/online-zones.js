// Level names for the public game browser (online-browse.js, contract v1.3): the broker lists each room's
// current zone as the game's path ("nyc/alison/nyc1_1_3"), and a player wants the level's name.
//
// NAMES maps a zone path, or a path prefix (a mission folder: "nyc/alison"), to its name; the longest
// match wins, so one entry can name a whole mission and another a single zone in it. A zone without an
// entry shows the last part of its path, as the contract says. Paths are matched in lower case, with '/'
// (a '\' from the game is read as '/').
//
// TODO(0.3.0): the X-Men Legends campaign zones. The launcher repo holds no game data to build the list
// from (and must not: tools/check_no_game_content.py), so the names come from the port's maintainers -
// one line per zone or mission, e.g.  'nyc/alison': 'Alison\'s rescue'. Until then every zone shows its
// last path part.
(function () {
    'use strict';

    const NAMES = {
    };

    function normalise(zone) {
        return String(zone || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '').toLowerCase();
    }

    // The level's name, the zone's last path part when no entry has it, '' for no zone.
    function levelName(zone) {
        const path = normalise(zone);
        if (!path) return '';
        const parts = path.split('/');
        for (let length = parts.length; length > 0; length--) {
            const key = parts.slice(0, length).join('/');
            if (Object.prototype.hasOwnProperty.call(NAMES, key)) return NAMES[key];
        }
        return String(zone).trim().replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
    }

    window.OnlineZones = { NAMES, levelName };
})();
