import { createServer, Server, Socket } from 'net';

/** Greets, answers EHLO with AUTH and refuses every login with 535; keeps the lines each client sent. */
export class FakeSmtpServer {
  public Sessions: string[][] = [];

  public Port = 0;

  public Address = '';

  private Server: Server = createServer((socket) => this.serve(socket));

  public async listen(host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.Server.once('error', reject);
      this.Server.listen(0, host, resolve);
    });
    const address = this.Server.address();
    this.Port = typeof address === 'object' && address !== null ? address.port : 0;
    this.Address = typeof address === 'object' && address !== null ? address.address : '';
  }

  public close(): Promise<void> {
    return new Promise((resolve) => this.Server.close(() => resolve()));
  }

  protected refusal(_line: string): string {
    return '535 5.7.8 Authentication credentials invalid\r\n';
  }

  private serve(socket: Socket): void {
    const lines: string[] = [];
    this.Sessions.push(lines);
    let pending = '';
    let login = 0;
    socket.on('error', () => undefined);
    socket.write('220 fake.invalid ESMTP\r\n');
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      for (let end = pending.indexOf('\r\n'); end >= 0; end = pending.indexOf('\r\n')) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        lines.push(line);
        socket.write(this.reply(line, login));
        login = /^AUTH LOGIN/i.test(line) || login === 1 ? login + 1 : 0;
        if (/^QUIT/i.test(line)) socket.end();
      }
    });
  }

  private reply(line: string, login: number): string {
    if (/^EHLO/i.test(line)) return '250-fake.invalid\r\n250 AUTH PLAIN LOGIN\r\n';
    if (/^AUTH LOGIN/i.test(line)) return '334 VXNlcm5hbWU6\r\n';
    if (login === 1) return '334 UGFzc3dvcmQ6\r\n';
    if (/^AUTH PLAIN/i.test(line) || login === 2) return this.refusal(line);
    if (/^QUIT/i.test(line)) return '221 bye\r\n';
    return '250 OK\r\n';
  }
}
