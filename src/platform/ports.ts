import * as net from 'node:net';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配调试端口')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
