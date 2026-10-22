import { Logger } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { RunnerConnections } from './runner-connections.service';
import {
  RUNNER_SOCKET_MAX_PAYLOAD,
  RUNNER_SOCKET_PATH,
  type RunnerUpgradeRequest,
} from './runner-socket';

/**
 * `wss://<host>/api/runner` (spec #151): the daemon's one connection.
 * Authentication already happened on the upgrade (`RunnerSocketAdapter`).
 */
@WebSocketGateway({
  path: RUNNER_SOCKET_PATH,
  maxPayload: RUNNER_SOCKET_MAX_PAYLOAD,
})
export class RunnerGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RunnerGateway.name);

  constructor(private readonly connections: RunnerConnections) {}

  handleConnection(socket: WebSocket, req: RunnerUpgradeRequest): void {
    if (!req.runnerAuth) {
      // Only when the adapter is not `RunnerSocketAdapter`: refuse loudly.
      this.logger.error('A runner socket opened without authentication');
      socket.terminate();
      return;
    }
    this.connections
      .accept(socket, req.runnerAuth, req.runnerIp)
      .catch((error: unknown) => {
        this.logger.error(error);
        socket.terminate();
      });
  }
}
