// Support > Known issues: what we know is not working yet, per game. Edit this list for each release
// (keep it in step with docs/release/*-notes.md "Known limitations"). Each entry has the text in English
// (en) and, when translated, French (fr) and Spanish (es); a missing language shows the English text.
// `game` is the launcher's game key, or 'launcher' for the launcher itself. Plain text only: the page
// shows it as text, never as HTML.
// KnownIssuesFor: per game, the versions the list was last checked against (shown above that game's list).
window.KnownIssuesFor = {
    xml1: 'Legends Classic 0.6.1 with XML2 Fix 1.11.2 or 1.12.0-beta.2'
};

window.KnownIssues = [
    {
        game: 'launcher',
        id: 'proton-file-dialog',
        text: {
            en: 'Under Proton (Steam Deck, Linux), picking a picture with Change artwork..., Change banner... or Change icon... goes through Wine\'s file dialog, which is not verified yet. Pictures you already chose are kept.',
            fr: 'Sous Proton (Steam Deck, Linux), choisir une image avec Change artwork..., Change banner... ou Changer l’icône... passe par la boîte de dialogue de Wine, qui n\'est pas encore vérifiée. Les images déjà choisies sont conservées.',
            es: 'En Proton (Steam Deck, Linux), elegir una imagen con Change artwork..., Change banner... o Cambiar icono... usa el diálogo de archivos de Wine, que aún no está verificado. Las imágenes que ya elegiste se conservan.'
        }
    },
    {
        game: 'launcher',
        id: 'no-linux-build',
        text: {
            en: 'Steam Deck and Linux: the launcher runs under Proton / Wine. There is no native Linux build.',
            fr: 'Steam Deck et Linux : le lanceur fonctionne sous Proton / Wine. Il n\'existe pas de version Linux native.',
            es: 'Steam Deck y Linux: el launcher funciona con Proton / Wine. No hay una versión nativa para Linux.'
        }
    },
    {
        game: 'muac',
        id: 'main-monitor-restart',
        text: {
            en: 'The resolution list comes from your main monitor when the launcher starts. After you change your main monitor (or its resolution), restart the launcher to see that monitor\'s sizes.',
            fr: 'La liste des résolutions vient de votre écran principal au démarrage du lanceur. Après avoir changé d\'écran principal (ou sa résolution), redémarrez le lanceur pour voir les tailles de cet écran.',
            es: 'La lista de resoluciones se toma de tu monitor principal cuando se inicia el launcher. Si cambias de monitor principal (o su resolución), reinicia el launcher para ver los tamaños de ese monitor.'
        }
    },
    {
        game: 'muac',
        id: 'display-scaling-window',
        text: {
            en: 'With Windows display scaling above 100% on the main monitor (a 4K screen at 150%, for example), Windowed and Borderless come out about 1.5x too big and spill onto another monitor. MUA Classic Fix 0.2.4 fixes this: choose Update on the MUA 2006 page. Until then, Fullscreen shows correctly.',
            fr: 'Avec une mise à l\'échelle Windows supérieure à 100 % sur l\'écran principal (un écran 4K à 150 %, par exemple), les modes Windowed et Borderless sont environ 1,5 fois trop grands et débordent sur un autre écran. MUA Classic Fix 0.2.4 corrige cela : choisissez Mettre a jour sur la page de MUA 2006. En attendant, le mode Fullscreen s\'affiche correctement.',
            es: 'Con un escalado de pantalla de Windows superior al 100 % en el monitor principal (una pantalla 4K al 150 %, por ejemplo), los modos Windowed y Borderless salen unas 1,5 veces demasiado grandes y se extienden a otro monitor. MUA Classic Fix 0.2.4 lo corrige: elige Actualizar en la página de MUA 2006. Mientras tanto, Fullscreen se ve bien.'
        }
    },
    {
        game: 'muac',
        id: 'proton-display-mode',
        text: {
            en: 'On Steam Deck / Proton, Proton handles the display mode, so the launcher hides the display options there.',
            fr: 'Sur Steam Deck / Proton, c\'est Proton qui gère le mode d\'affichage : le lanceur y masque donc les options d\'affichage.',
            es: 'En Steam Deck / Proton, Proton gestiona el modo de pantalla, así que el launcher oculta allí las opciones de pantalla.'
        }
    },
    {
        game: 'muac',
        id: 'display-failed',
        text: {
            en: 'A size dgVoodoo2 can\'t show on the monitor it uses fails with "Display failed!" (for example 3840x2160 on a 1440p main monitor). This only happens with a size saved by hand or on another PC: pick one of the listed sizes.',
            fr: 'Une taille que dgVoodoo2 ne peut pas afficher sur son écran échoue avec « Display failed! » (par exemple 3840x2160 sur un écran principal 1440p). Cela n\'arrive qu\'avec une taille saisie à la main ou enregistrée sur un autre PC : choisissez une des tailles proposées.',
            es: 'Un tamaño que dgVoodoo2 no puede mostrar en su monitor falla con "Display failed!" (por ejemplo 3840x2160 en un monitor principal de 1440p). Solo ocurre con un tamaño puesto a mano o guardado en otro PC: elige uno de los tamaños de la lista.'
        }
    },
    {
        game: 'muac',
        id: 'windowed-full-size',
        text: {
            en: 'Windowed at your monitor\'s full size is taller than the screen by the title bar; use Borderless for that.',
            fr: 'En mode Windowed à la taille complète de l\'écran, la fenêtre dépasse de la hauteur de la barre de titre ; utilisez Borderless dans ce cas.',
            es: 'En modo Windowed al tamaño completo del monitor, la ventana es más alta que la pantalla por la barra de título; usa Borderless para eso.'
        }
    },
    {
        game: 'muac',
        id: 'proton-not-on-deck',
        text: {
            en: 'MUA 2006 under Proton was tested under GE-Proton on Linux up to its main menu, not yet on a real Steam Deck: gameplay, controllers through Steam Input, saves and online play are not confirmed yet. Please tell us how it goes on a Deck.',
            fr: 'MUA 2006 sous Proton a été testé avec GE-Proton sous Linux jusqu\'à son menu principal, pas encore sur un vrai Steam Deck : le jeu lui-même, les manettes via Steam Input, les sauvegardes et le jeu en ligne ne sont pas encore confirmés. Dites-nous comment ça se passe sur un Deck.',
            es: 'MUA 2006 en Proton se probó con GE-Proton en Linux hasta su menú principal, aún no en un Steam Deck real: el juego en sí, los mandos con Steam Input, las partidas guardadas y el juego en línea aún no están confirmados. Cuéntanos qué tal va en un Deck.'
        }
    },
    {
        game: 'xml1',
        id: 'online-fix-version',
        text: {
            en: 'Online: everyone in the party needs XML2 Fix 1.11.2 or 1.12.0-beta.2 (the internet play fix), plus the same Legends Classic build and gameplay settings. A PC with an older XML2 Fix is refused ("The host\'s game refused you. Check build and settings." or "Everyone must update XML2 Fix") or its join times out.',
            fr: 'En ligne : tout le groupe a besoin de XML2 Fix 1.11.2 ou 1.12.0-beta.2 (le correctif du jeu par Internet), ainsi que de la même version de Legends Classic et des mêmes réglages de jeu. Un PC avec un XML2 Fix plus ancien est refusé (« The host\'s game refused you. Check build and settings. » ou « Everyone must update XML2 Fix ») ou sa connexion expire.',
            es: 'En línea: todo el grupo necesita XML2 Fix 1.11.2 o 1.12.0-beta.2 (la corrección del juego por Internet), además de la misma versión de Legends Classic y los mismos ajustes de juego. Un PC con un XML2 Fix más antiguo es rechazado ("The host\'s game refused you. Check build and settings." o "Everyone must update XML2 Fix") o su conexión agota el tiempo de espera.'
        }
    },
    {
        game: 'xml1',
        id: 'online-little-tested',
        text: {
            en: 'Online play between different homes, through the relay, with three or four separate PCs and in long sessions has had little testing so far. If something goes wrong, keep xml2-fix.log from every PC.',
            fr: 'Le jeu en ligne entre plusieurs foyers, via le relais, avec trois ou quatre PC distincts et sur de longues sessions a encore été peu testé. En cas de problème, gardez le fichier xml2-fix.log de chaque PC.',
            es: 'El juego en línea entre distintas casas, a través del relé, con tres o cuatro PC distintos y en sesiones largas aún se ha probado poco. Si algo falla, guarda el archivo xml2-fix.log de cada PC.'
        }
    },
    {
        game: 'xml1',
        id: 'online-host-leaves',
        text: {
            en: 'Online: if the host leaves, the session ends. There is no host migration or automatic reconnect yet; guests can join again by code.',
            fr: 'En ligne : si l\'hôte part, la session se termine. Il n\'y a pas encore de migration d\'hôte ni de reconnexion automatique ; les invités peuvent revenir avec le code.',
            es: 'En línea: si el anfitrión se va, la sesión termina. Aún no hay migración de anfitrión ni reconexión automática; los invitados pueden volver a unirse con el código.'
        }
    },
    {
        game: 'xml1',
        id: 'online-join-next-area',
        text: {
            en: 'A friend who joins a game in progress comes in at the host\'s next area, not mid-level. Everyone reloads that area together, so that load takes a little longer.',
            fr: 'Un ami qui rejoint une partie en cours arrive à la prochaine zone de l\'hôte, pas en plein niveau. Tout le monde recharge cette zone ensemble, ce chargement est donc un peu plus long.',
            es: 'Un amigo que se une a una partida en curso entra en la siguiente zona del anfitrión, no a mitad de nivel. Todos recargan esa zona juntos, así que esa carga tarda un poco más.'
        }
    },
    {
        game: 'xml1',
        id: 'four-player-pause',
        text: {
            en: 'With four players, a Ready press on the pause screen can occasionally not register (seen in tests). Press Ready again.',
            fr: 'À quatre joueurs, un appui sur Ready à l\'écran de pause peut parfois ne pas être pris en compte (vu en test). Appuyez de nouveau sur Ready.',
            es: 'Con cuatro jugadores, a veces una pulsación de Ready en la pantalla de pausa no se registra (visto en pruebas). Pulsa Ready otra vez.'
        }
    },
    {
        game: 'xml1',
        id: 'skirmish-experimental',
        text: {
            en: 'Skirmish is experimental. Everyone joins in the lobby before the host starts a round; a friend who asks to join a round already under way is refused. Not every hero, power and arena has been tested yet.',
            fr: 'Le mode Skirmish est expérimental. Tout le monde rejoint le salon avant que l\'hôte lance une manche ; un ami qui demande à rejoindre une manche en cours est refusé. Tous les héros, pouvoirs et arènes n\'ont pas encore été testés.',
            es: 'El modo Skirmish es experimental. Todos se unen en la sala antes de que el anfitrión empiece una ronda; a un amigo que pide unirse a una ronda ya empezada se le rechaza. Aún no se han probado todos los héroes, poderes y arenas.'
        }
    },
    {
        game: 'xml1',
        id: 'enemy-attack-rate',
        text: {
            en: 'Some enemies (the Brotherhood in the HAARP tunnels, for example) attack more often than in the original game (issue #101).',
            fr: 'Certains ennemis (la Confrérie dans les tunnels de HAARP, par exemple) attaquent plus souvent que dans le jeu original (ticket n° 101).',
            es: 'Algunos enemigos (la Hermandad en los túneles de HAARP, por ejemplo) atacan más a menudo que en el juego original (incidencia n.º 101).'
        }
    },
    {
        game: 'xml1',
        id: 'fall-zones-off',
        text: {
            en: 'Some of the original game\'s fall kill zones are still switched off until they are proven safe (issue #22).',
            fr: 'Certaines zones de chute mortelle du jeu original restent désactivées tant qu\'elles ne sont pas jugées sûres (ticket n° 22).',
            es: 'Algunas zonas de caída mortal del juego original siguen desactivadas hasta que se demuestre que son seguras (incidencia n.º 22).'
        }
    },
    {
        game: 'xml1',
        id: 'shared-settings',
        text: {
            en: 'Key bindings and display settings are shared with X-Men Legends II (the same Windows settings). Saves are separate.',
            fr: 'Les touches et les réglages d\'affichage sont partagés avec X-Men Legends II (les mêmes réglages Windows). Les sauvegardes sont séparées.',
            es: 'Los controles y los ajustes de pantalla se comparten con X-Men Legends II (los mismos ajustes de Windows). Las partidas guardadas son independientes.'
        }
    },
    {
        game: 'xml1',
        id: 'save-import-off',
        text: {
            en: 'Importing saves from xemu or XML1-recomp is switched off for now.',
            fr: 'L\'import de sauvegardes depuis xemu ou XML1-recomp est désactivé pour l\'instant.',
            es: 'La importación de partidas guardadas de xemu o XML1-recomp está desactivada por ahora.'
        }
    },
    {
        game: 'xml1',
        id: 'models-take-time',
        text: {
            en: 'Converting character models takes a while: about half a minute per hero from Marvel: Ultimate Alliance, several minutes for some Marvel: Ultimate Alliance 2 heroes. The game must be closed while the models change.',
            fr: 'La conversion des modèles de personnages prend du temps : environ une demi-minute par héros de Marvel: Ultimate Alliance, plusieurs minutes pour certains héros de Marvel: Ultimate Alliance 2. Le jeu doit être fermé pendant le changement des modèles.',
            es: 'Convertir los modelos de personajes lleva un tiempo: alrededor de medio minuto por héroe de Marvel: Ultimate Alliance y varios minutos para algunos héroes de Marvel: Ultimate Alliance 2. El juego debe estar cerrado mientras cambian los modelos.'
        }
    },
    {
        game: 'xml1',
        id: 'costume-numbers',
        text: {
            en: 'Some costume names are still shown by number ("MUA1 costume 0801").',
            fr: 'Certains costumes sont encore affichés par numéro (« MUA1 costume 0801 »).',
            es: 'Algunos trajes todavía se muestran por número ("MUA1 costume 0801").'
        }
    }
];
