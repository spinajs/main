import WebSocket from 'ws';

const [url = 'ws://127.0.0.1:61614/ws', login = 'spinajs', passcode = 'spinajs'] = process.argv.slice(2);
const socket = new WebSocket(url, ['v12.stomp']);
const timer = setTimeout(() => {
  console.error('TIMEOUT');
  process.exit(2);
}, 10000);

socket.on('open', () => {
  socket.send(`CONNECT\naccept-version:1.2\nhost:localhost\nlogin:${login}\npasscode:${passcode}\n\n\0`);
});

socket.on('message', (data) => {
  const frame = String(data);
  const command = frame.split('\n')[0];
  const message = /\nmessage:([^\n]*)/.exec(frame)?.[1] ?? '';
  console.log(message ? `${command} ${message}` : command);
  clearTimeout(timer);
  socket.close();
  process.exit(command === 'CONNECTED' ? 0 : 1);
});

socket.on('error', (err) => {
  console.error(`SOCKET ${err.message}`);
  process.exit(1);
});
