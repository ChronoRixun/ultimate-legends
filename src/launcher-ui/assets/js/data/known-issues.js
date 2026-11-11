// Support > Known issues: what we know is not working yet, per game. Edit this list for each release
// (keep it in step with docs/release/*-notes.md "Known limitations"). Each entry has the text in English
// (en) and, when translated, French (fr) and Spanish (es); a missing language shows the English text.
// `game` is the launcher's game key, or 'launcher' for the launcher itself. Plain text only: the page
// shows it as text, never as HTML.
window.KnownIssues = [
    {
        game: 'launcher',
        id: 'proton-file-dialog',
        text: {
            en: 'Under Proton (Steam Deck, Linux), picking a picture with Change artwork... or Change banner... goes through Wine\'s file dialog, which is not verified yet. Pictures you already chose are kept.',
            fr: 'Sous Proton (Steam Deck, Linux), choisir une image avec Change artwork... ou Change banner... passe par la boîte de dialogue de Wine, qui n\'est pas encore vérifiée. Les images déjà choisies sont conservées.',
            es: 'En Proton (Steam Deck, Linux), elegir una imagen con Change artwork... o Change banner... usa el diálogo de archivos de Wine, que aún no está verificado. Las imágenes que ya elegiste se conservan.'
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
