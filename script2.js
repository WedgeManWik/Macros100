const fs = require('fs');
let code = fs.readFileSync('client/src/DietPlanner.tsx', 'utf8');

// Fix step 13: hideNextButton and hideBackButton
code = code.replace(/hideFooter: true,/g, "hideFooter: true,\n    hideNextButton: true,\n    hideBackButton: true,");

// Fix step 14: placement 'top' to 'center'
code = code.replace(/target: '.tour-liked-modal',\r?\n\s+placement: 'top',/g, "target: '.tour-liked-modal',\n    placement: 'center',");

fs.writeFileSync('client/src/DietPlanner.tsx', code);
