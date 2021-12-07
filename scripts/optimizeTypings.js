const fs = require('fs');


const fileContents = fs.readFileSync('./dist/node/index.d.ts').toString().split(/\r\n|\r|\n/g);
let filterContents = [];
fileContents.forEach(line => {
    if (
        /\/{3}\ \<reference.*vscode\.d\.ts\"/.test(line)
        || /\/{3}\ \<reference.*vscode\.proposed\.d\.ts\"/.test(line)
        ) {
        // no op as we want to filter out vscode
    } else {
        filterContents.push(line);
    }
});

fs.writeFileSync('./dist/node/index.d.ts', filterContents.join('\n'));
console.log('Optimized d.ts')
