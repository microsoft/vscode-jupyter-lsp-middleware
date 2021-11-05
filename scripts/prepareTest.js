const fs = require('fs');
console.log('Copying package.json to out folder')
if (!fs.existsSync('./out')) {
  fs.mkdirSync('./out');
  fs.mkdirSync('./out/test');
}
fs.copyFile('./src/test/package.json', './out/test/package.json', (err) => {
  if (err) throw err;
  console.log('src/test/package.json was copied to out/test/package.json');
});
