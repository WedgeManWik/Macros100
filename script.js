const fs = require('fs');
let code = fs.readFileSync('client/src/DietPlanner.tsx', 'utf8');
code = code.replace(/target: '.tour-liked',\r?\n\s+content: 'Now, click this button to open the Liked Foods menu! The algorithm will only pick foods from your liked list.',\r?\n\s+spotlightClicks: true,\r?\n\s+disableBeacon: true,/, "target: '.tour-liked',\n    content: 'Now, click this button to open the Liked Foods menu! The algorithm will only pick foods from your liked list.',\n    spotlightClicks: true,\n    disableBeacon: true,\n    hideFooter: true,");
fs.writeFileSync('client/src/DietPlanner.tsx', code);
