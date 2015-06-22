declare module "data-beams" {

    import stream = require('stream');
    import events = require('events');
    import net = require('net');

    export var MAX_SAFE_INT: number;
    export var MAX_UINT_32: number;
    export var MAX_PACKET_SIZE: number;

    export class TransferIn extends stream.Readable {
        id: number;
        complete: boolean;
        _received: number;
        _push: (chunk: any, encoding?: string) => boolean;
        _data: NodeBuffer[];
        constructor(id: number);
        addData(data: NodeBuffer): boolean;
        end(): void;
    }

    export class TransferOut extends events.EventEmitter {
        id: number;
        socket: net.Socket;
        start(id: number, socket: net.Socket): void;
        sendData(buffer: NodeBuffer): void;
        transfer(): void;
    }

    export class BufferTransferOut extends TransferOut {
        data: NodeBuffer;
        constructor(data: NodeBuffer);
        transfer(): void;
    }

    export class StreamingTransferOut extends TransferOut {
        stream: stream.Readable;
        constructor(stream: stream.Readable);
        transfer(): void;
    }

    export class Connection extends events.EventEmitter {
        id: number;
        socket: net.Socket;
        connected: boolean;
        remoteAddress: string;
        remoteFamily: string;
        remotePort: number;
        transfersIn: {
            [id: number]: TransferIn;
        };
        transfersOut: TransferOut[];
        queuedTransfers: TransferOut[];
        _xferOutStartHeader: NodeBuffer;
        _xferOutEndHeader: NodeBuffer;
        constructor(socket: net.Socket, id?: number, connected?: boolean);
        _queueTransfer(transfer: TransferOut): void;
        sendStream(stream: stream.Readable): StreamingTransferOut;
        sendBuffer(data: NodeBuffer): BufferTransferOut;
        close(): void;
        destroy(): void;
    }

    export class Server extends events.EventEmitter {
        port: number;
        server: net.Server;
        connections: {
            [id: number]: Connection;
        };
        listening: boolean;
        constructor(port?: number);
        listen(): void;
    }

    export class Client extends Connection {
        address: string;
        port: number;
        connection: Connection;
        constructor(address: string, port?: number);
    }

}
