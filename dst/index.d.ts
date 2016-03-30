/// <reference path="../lib/node.d.ts" />
import stream = require('stream');
import events = require('events');
import net = require('net');
export declare var MAX_SAFE_INT: number;
export declare var MAX_UINT_32: number;
export declare var MAX_PACKET_SIZE: number;
export declare class ArrayBufferedStream extends stream.Readable implements NodeJS.WritableStream {
    writable: boolean;
    _ended: boolean;
    _received: number;
    constructor();
    write(buffer: Buffer, cb?: Function): boolean;
    write(str: string, cb?: Function): boolean;
    write(str: string, encoding?: string, cb?: Function): boolean;
    end(): void;
    end(buffer: Buffer, cb?: Function): void;
    end(str: string, cb?: Function): void;
    end(str: string, encoding?: string, cb?: Function): void;
    _read(size: number): void;
}
export declare class TransferIn extends ArrayBufferedStream {
    id: number;
    constructor(id: number);
}
export declare class TransferOut extends events.EventEmitter {
    id: number;
    socket: net.Socket;
    start(id: number, socket: net.Socket): void;
    sendData(buffer: NodeBuffer, cb?: () => void): void;
    transfer(): void;
}
export declare class BufferTransferOut extends TransferOut {
    data: NodeBuffer;
    constructor(data: NodeBuffer);
    transfer(): void;
}
export declare class StreamingTransferOut extends TransferOut {
    stream: stream.Readable;
    _packetsPushed: number;
    _packetsSent: number;
    _ended: boolean;
    _complete: boolean;
    constructor(stream: stream.Readable);
    transfer(): void;
}
export declare class Connection extends events.EventEmitter {
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
    constructor(socket: net.Socket, id?: number, connected?: boolean);
    _queueTransfer(transfer: TransferOut): void;
    sendStream(stream: stream.Readable): StreamingTransferOut;
    sendBuffer(data: NodeBuffer): BufferTransferOut;
    close(): void;
    destroy(): void;
}
export declare class Server extends events.EventEmitter {
    port: number;
    server: net.Server;
    connections: {
        [id: number]: Connection;
    };
    listening: boolean;
    constructor(port?: number);
    listen(): void;
}
export declare class Client extends Connection {
    address: string;
    port: number;
    connection: Connection;
    constructor(address: string, port?: number);
}
