const fs = require('fs');
let code = fs.readFileSync('client/src/DietPlanner.tsx', 'utf8');

// Replace Step 13
code = code.replace(/target: '.tour-liked',\r?\n\s+content: 'Now, click this button to open the Liked Foods menu! The algorithm will only pick foods from your liked list.',\r?\n\s+spotlightClicks: true,\r?\n\s+disableBeacon: true,\r?\n\s+hideFooter: true,\r?\n\s+hideNextButton: true,\r?\n\s+hideBackButton: true,/, "target: '.tour-liked',\n      content: 'Now, click this button to open the Liked Foods menu! The algorithm will only pick foods from your liked list.',\n      spotlightClicks: true,\n      disableBeacon: true,\n      styles: {\n        buttonNext: {\n          display: 'none'\n        },\n        buttonBack: {\n          display: 'none'\n        }\n      }");

// Replace Step 14
code = code.replace(/target: '.tour-liked-modal',\r?\n\s+placement: 'center',\r?\n\s+content: 'This is the Liked Foods Menu! Here you can search, filter, and toggle foods you like or dislike. When you are done, close the menu to continue the tour.',\r?\n\s+spotlightClicks: true,\r?\n\s+disableBeacon: true,/, "target: '.tour-liked-modal',\n      placement: 'center',\n      content: 'This is the Liked Foods Menu! Here you can search, filter, and toggle foods you like or dislike. When you are done, close the menu to continue the tour.',\n      spotlightClicks: true,\n      disableBeacon: true,\n      styles: {\n        overlay: {\n          pointerEvents: 'none'\n        }\n      }");

fs.writeFileSync('client/src/DietPlanner.tsx', code);
