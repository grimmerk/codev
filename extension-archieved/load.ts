const { spawn } = require('child_process');
const packageJSON = require('./package.json');
const { version } = packageJSON;
const cmd = spawn('code', ['--install-extension', `SwitchV-${version}.vsix`]);
cmd.stdout.on('data', (data: any) => {
  // console.log(`stdout: ${data}`);
});
