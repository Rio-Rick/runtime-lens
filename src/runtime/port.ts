import * as net from 'node:net';

/**
 * Resolve a usable localhost port.
 *
 * `preferred === 0` asks the OS for an ephemeral port, which is race-free.
 * A non-zero preference is probed first and quietly abandoned if taken, so a
 * second VS Code window never fails to start - it just gets another port.
 */
export async function findFreePort(preferred = 0, host = '127.0.0.1'): Promise<number> {
  if (preferred > 0 && (await isPortFree(preferred, host))) {
    return preferred;
  }
  return getEphemeralPort(host);
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

export function getEphemeralPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('could not obtain an ephemeral port'))));
    });
  });
}
