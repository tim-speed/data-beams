/// <reference path="../lib/node.d.ts" />

import stream = require('stream');
import events = require('events');
import net = require('net');

var debug = require('./debug');

export var MAX_SAFE_INT = 9007199254740991;
export var MAX_UINT_32 = 0xFFFFFFFF;
export var MAX_PACKET_SIZE = 1400; // 1500 is the max ethernet mtu, 1400 gives us enough room for underlying protocols and our headers to avoid packet loss and corruption

var EMPTY_BUFFER = new Buffer(0);

var dbgArrayBufferedStream = debug('ArrayBufferedStream');

export class ArrayBufferedStream extends stream.Readable implements NodeJS.WritableStream {
    // TODO: Use this as flow control so the buffer doesn't get too big
    writable: boolean;

    _ended: boolean;
    _received: number;

    constructor() {
        // Specify that this should buffer lots of data 4GB
        super({
            highWaterMark: MAX_UINT_32
        });

        // By default buffer slicing is off so that we don't screw up message packets and so they don't have to measure their own length
        this.writable = true;
        this._ended = false;
        this._received = 0;
    }

    write(buffer: Buffer, cb?: Function): boolean;
    write(str: string, cb?: Function): boolean;
    write(str: string, encoding?: string, cb?: Function): boolean;
    write(data: string|Buffer, encodingOrCb?: Function|string, cb?: Function): boolean {
        if (this._ended) {
            cb && setImmediate(cb);
            return;
        }

        var encoding = 'utf8';

        if (typeof encodingOrCb === 'function') {
            cb = encodingOrCb;
        } else if (typeof encodingOrCb === 'string') {
            encoding = encoding;
        }

        if (typeof data === 'string') {
            data = new Buffer(<string>data, encoding);
        }

        dbgArrayBufferedStream('Adding %d bytes of data', data.length);

        this.push(<Buffer>data);
        this._received += (<Buffer>data).length;

        cb && setImmediate(cb);

        return true;
    }

    // Ends the stream so no more data can be written to it or read from it beyond what has already been written to it
    end(): void;
    end(buffer: Buffer, cb?: Function): void;
    end(str: string, cb?: Function): void;
    end(str: string, encoding?: string, cb?: Function): void;
    end(data?: string|Buffer, encodingOrCb?: Function|string, cb?: Function): void {
        if (this._ended) {
            cb && setImmediate(cb);
            return;
        }

        if (data) {
            this.write(<string>data, <string>encodingOrCb, cb);
        }

        dbgArrayBufferedStream('Ending stream');

        this.writable = false;
        this._ended = true;
        this.push(null);
    }

    _read(size: number) {
        // Do nothing, this stream relies on the underlying readable, with an extremely high watermark
    }
}

var dbgTransferIn = debug('TransferIn');

// TODO: Limit the amount this buffers or else we will run out of the memory
export class TransferIn extends ArrayBufferedStream {

    id: number;

    constructor(id: number) {
        super();

        this.id = id;
        dbgTransferIn('Starting inbound transfer %d.', this.id);
    }

}

var dbgTransferOut = debug('TransferOut');

export class TransferOut extends events.EventEmitter {

    id: number;
    socket: net.Socket;

    start(id: number, socket: net.Socket) {
        this.id = id;
        this.socket = socket;
        this.transfer();
        this.emit('started');
        dbgTransferOut('Started outbound transfer %d', id);
    }

    sendData(buffer: NodeBuffer, cb?: () => void) {
        dbgTransferOut('Continuing outbound transfer %d, sending %d bytes.', this.id, buffer.length);
        var outBuffer = new Buffer(7 + buffer.length);
        // Write flags
        outBuffer.writeUInt8(TransferFlags.Continue, 0);
        // Write transfer id
        outBuffer.writeUInt32BE(this.id, 1);
        // Write packet length
        outBuffer.writeUInt16BE(buffer.length, 5);
        // Write out buffer
        buffer.copy(outBuffer, 7, 0, buffer.length);
        this.socket.write(outBuffer, cb);
    }

    transfer() {
        throw new Error('transfer() not yet implemented in derived class of TransferOut!');
    }

}

export class BufferTransferOut extends TransferOut {

    data: NodeBuffer;

    constructor(data: NodeBuffer) {
        super();
        this.data = data;
    }

    transfer() {
        var _ = this;
        var outData = _.data;
        var started = 0;
        var sent = 0;
        while (outData.length) {
            // Split into parts based on the max packet size
            var bytesInPart = Math.min(outData.length, MAX_PACKET_SIZE);
            var part = outData.slice(0, bytesInPart);
            // Update outData for next iteration
            outData = outData.slice(bytesInPart);
            // Send the part
            _.sendData(part, function completeCheck() {
                sent++;
                if (sent === started) {
                    _.emit('complete');
                    dbgTransferOut('Buffer Sent - Completed outbound transfer %d.', _.id);
                }
            });
            started++;
        }
    }

}

export class StreamingTransferOut extends TransferOut {

    stream: stream.Readable;

    _packetsPushed: number;
    _packetsSent: number;
    _ended: boolean;
    _complete: boolean;

    constructor(stream: stream.Readable) {
        super();
        this.stream = stream;
        this.stream.pause();
        this._packetsPushed = 0;
        this._packetsSent = 0;
        this._ended = false;
        this._complete = false;
    }

    transfer() {
        var _ = this;
        _.stream.resume();
        function onData(data: NodeBuffer) {
            var outData = data;
            while (outData.length) {
                // Split into parts based on the max packet size
                var bytesInPart = Math.min(outData.length, MAX_PACKET_SIZE);
                var part = outData.slice(0, bytesInPart);
                _._packetsPushed++;
                // Update outData for next iteration
                outData = outData.slice(bytesInPart);
                // Send the part
                _.sendData(part, function completeCheck() {
                    _._packetsSent++;
                    // TODO: Figure out what this is for... the end handler should be what handles this
                    if (!_._complete && _._ended && _._packetsPushed === _._packetsSent) {
                        _._complete = true;
                        _.emit('complete');
                        dbgTransferOut('Stream Ended Before End - Completed outbound transfer %d.', _.id);
                    }
                });
            }
        }
        _.stream.on('data', onData);
        _.stream.once('end', function onEnd() {
            // All done!
            _.stream.removeListener('data', onData);
            _._ended = true;
            if (!_._complete && _._packetsPushed === _._packetsSent) {
                _._complete = true;
                _.emit('complete');
                dbgTransferOut('Stream End - Completed outbound transfer %d.', _.id);
            }
        });
    }

}

enum TransferFlags {
    Start    = 0b10000000, // Transfer start
    Ack      = 0b01000000, // Transfer ack
    End      = 0b00100000, // Transfer end
    Continue = 0b00010000 // Normal transfer continuation
    //         0b00001000 : Transfer error? (NYI)
}

var dbgConnection = debug('Connection');

export class Connection extends events.EventEmitter {

    // Core props
    id: number;
    socket: net.Socket;

    // Easy access
    connected: boolean;
    remoteAddress: string;
    remoteFamily: string;
    remotePort: number;

    // Data
    transfersIn: { [id: number]: TransferIn; };
    transfersOut: TransferOut[];
    queuedTransfers: TransferOut[];

    // Hidden
    _xferOutStartHeader: NodeBuffer;

    constructor(socket: net.Socket, id?: number, connected?: boolean) {
        super();

        this.id = id || -1;
        this.socket = socket;

        this.connected = !!connected;
        this.remoteAddress = socket.remoteAddress;
        this.remoteFamily = socket.remoteFamily;
        this.remotePort = socket.remotePort;

        this.transfersIn = {};
        this.transfersOut = [];
        this.queuedTransfers = [];

        this._xferOutStartHeader = new Buffer(1);
        // Set Flags
        // FLAGS:
        // 0b10000000 : Transfer start
        // 0b01000000 : Transfer ack
        // 0b00100000 : Transfer end
        // 0b00010000 : Transfer error? (NYI)
        // 0b00000000 : Normal transfer continuation
        this._xferOutStartHeader.writeUInt8(TransferFlags.Start, 0);

        var _ = this;
        // Bind to process data-packets
        var packetInTransit = false;
        var currentPacketFlags = 0;
        var currentPacketHeaderResolved = false;
        var currentPacketLength = 0;
        var currentPacketTransfer: TransferIn = null;
        var currentPacketBytesRemaining = 0;
        var packetTrimmings: NodeBuffer = null;
        var transferResponseHeader: NodeBuffer = new Buffer(5);

        // 0b01000000 : Transfer ack
        transferResponseHeader.writeInt8(TransferFlags.Ack, 0);
        // Next 4 Bytes are reserved for transfer id

        socket.on('data', function onData(data: NodeBuffer) {
            // Append previous trimmings if available
            // TODO: Find a better solution over packetTrimmings
            if (packetTrimmings) {
                dbgConnection('Concating bufferTrimmings(%d) to data(%d)', packetTrimmings.length, data.length);
                data = Buffer.concat([packetTrimmings, data], packetTrimmings.length + data.length);
                packetTrimmings = null;
            }

            dbgConnection('Processing buffer, length %d bytes', data.length);
            var packetOffset = 0;
            var bytesRemainingInBuffer = 0;
            var headerBytesNeeded = 0;
            var xferId: number;
            var xferIn: TransferIn;

            dataLoop:
            while (true) {
                // Loop must continue until explicitly exited
                bytesRemainingInBuffer = data.length - packetOffset;
                dbgConnection('Processing buffer remaining bytes (%d) expected in packet (%d)', bytesRemainingInBuffer, currentPacketBytesRemaining);

                if (currentPacketFlags && !currentPacketHeaderResolved) {
                    switch (currentPacketFlags) {
                        case TransferFlags.Start: {
                            // Start a new inbound transfer
                            while ((xferId = Math.floor(Math.random() * MAX_UINT_32)) &&
                                _.transfersIn[xferId])
                                continue;
                            xferIn = _.transfersIn[xferId] =
                                new TransferIn(xferId);
                            dbgConnection('New transfer id (%d)', xferId);
                            // Return the assigned transferId, Acking this transfer
                            transferResponseHeader.writeUInt32BE(xferId, 1);
                            socket.write(transferResponseHeader);
                            _.emit('transfer', xferIn);
                            break;
                        }
                        case TransferFlags.Ack: {
                            // Check if we have enough data to process this
                            if (bytesRemainingInBuffer < 4) {
                                // Trim off whats left of the packet and wait for more
                                if (bytesRemainingInBuffer > 0) {
                                    // Store the header trimmings, we will re-resolve this flag tree base on currentPacketFlags var storage
                                    dbgConnection('Ack - Storing packet trimmings, %d bytes', bytesRemainingInBuffer);
                                    packetTrimmings = data.slice(packetOffset);
                                }
                                break dataLoop;
                            }

                            // Start our outbound transfer
                            xferId = data.readUInt32BE(packetOffset);
                            dbgConnection('Ack - Read transfer id (%d)', xferId);
                            packetOffset += 4;
                            // This is the transfer id of a packet that we just sent
                            dbgConnection('Remote acknowledged our transfer (%d), starting...', xferId);
                            var transferOut = _.queuedTransfers.shift();
                            transferOut.start(xferId, socket);
                            _.transfersOut.push(transferOut);
                            break;
                        }
                        case TransferFlags.End: {
                            // Check if we have enough data to process this
                            if (bytesRemainingInBuffer < 4) {
                                // Trim off whats left of the packet and wait for more
                                if (bytesRemainingInBuffer > 0) {
                                    // Store the header trimmings, we will re-resolve this flag tree base on currentPacketFlags var storage
                                    dbgConnection('End - Storing packet trimmings, %d bytes', bytesRemainingInBuffer);
                                    packetTrimmings = data.slice(packetOffset);
                                }
                                break dataLoop;
                            }

                            // End a running transfer
                            xferId = data.readUInt32BE(packetOffset);
                            dbgConnection('End - Read transfer id (%d)', xferId);
                            packetOffset += 4;
                            // Grab and end the transger
                            xferIn = _.transfersIn[xferId];
                            if (xferIn) {
                                xferIn.end();
                            } else {
                                dbgConnection('Error, could not end non existent inbound transfer: %d', xferId);
                            }
                            break;
                        }
                        case TransferFlags.Continue: {
                            // Check if we have enough data to process this
                            if (bytesRemainingInBuffer < 6) {
                                // Trim off whats left of the packet and wait for more
                                if (bytesRemainingInBuffer > 0) {
                                    // Store the header trimmings, we will re-resolve this flag tree base on currentPacketFlags var storage
                                    dbgConnection('Continue - Storing packet trimmings, %d bytes', bytesRemainingInBuffer);
                                    packetTrimmings = data.slice(packetOffset);
                                }
                                break dataLoop;
                            }

                            // Handle incoming packet data for transfer
                            xferId = data.readUInt32BE(packetOffset);
                            dbgConnection('Continue - Read transfer id (%d)', xferId);
                            packetOffset += 4;
                            currentPacketTransfer = _.transfersIn[xferId];
                            if (!currentPacketTransfer)
                                throw new Error('data-beams: No transfer matching id = ' + xferId);
                            // Get the length of the expected
                            currentPacketLength = currentPacketBytesRemaining = data.readUInt16BE(packetOffset);
                            dbgConnection('Read packet length (%d)', currentPacketLength);
                            packetOffset += 2;

                            break;
                        }
                        default: {
                            dbgConnection('Error, invalid packet flags: %d', currentPacketFlags);
                            currentPacketFlags = 0;
                            // TODO: Send error
                            //throw new Error('Error, invalid packet flags: ' + currentPacketFlags);
                            break;
                        }
                    }
                    // Resolved the packet header
                    currentPacketHeaderResolved = true;
                }

                if (!(bytesRemainingInBuffer = data.length - packetOffset)) {
                    break dataLoop;
                }

                // Look for data to transfer
                if (currentPacketTransfer) {
                    // Take as much data from "data" as we can or until our length is satisfied
                    if (bytesRemainingInBuffer >= currentPacketBytesRemaining) {
                        dbgConnection('Continuing transfer id (%d) received (%d) adding (%d) satisfied', currentPacketTransfer.id, currentPacketTransfer._received, currentPacketBytesRemaining);
                        // This may happen frequently with small transfer blocks
                        currentPacketTransfer.write(data.slice(packetOffset, packetOffset + currentPacketBytesRemaining));
                        packetOffset += currentPacketBytesRemaining;
                        bytesRemainingInBuffer -= currentPacketBytesRemaining;
                        // Done with this transfer packet
                        currentPacketTransfer = null;
                        currentPacketLength = currentPacketBytesRemaining = 0;
                        currentPacketFlags = 0;
                    } else if (bytesRemainingInBuffer > 0) {
                        dbgConnection('Continuing transfer id (%d) received (%d) adding (%d) unsatisfied', currentPacketTransfer.id, currentPacketTransfer._received, bytesRemainingInBuffer);
                        // This may happen frequently with really large transfer blocks
                        // Supply what we can
                        currentPacketTransfer.write(data.slice(packetOffset));
                        currentPacketBytesRemaining -= bytesRemainingInBuffer;
                        // Maxed out buffer, continue at next packet
                        break dataLoop;
                    } else {
                        dbgConnection('Continuing transfer id (%d) received (%d) WARNING No bytes provided?..', currentPacketTransfer.id, currentPacketTransfer._received);
                        // There are no bytes left in this buffer, but we may still be expecting some
                        // this happens when headers are sent ahead of their data, so they aren't buffered together
                        // By breaking early before the packet trimming handler we preserve the current packet length
                        // and bytes remaining so the transfer can continue on the next data buffer received
                        break dataLoop;
                    }
                }

                if (bytesRemainingInBuffer) {
                    // This is the start of a new packet
                    // Grab the flags from this packet
                    currentPacketFlags = data.readUInt8(packetOffset);
                    packetOffset++;
                    dbgConnection('Read packet flags (%d)', currentPacketFlags);
                    // Reset header resolved so we know to read it
                    currentPacketHeaderResolved = false;
                } else {
                    break dataLoop;
                }
            }

            dbgConnection('Done processing buffer, length %d bytes', data.length);
        });

        // Bubble events:
        socket.on('error', function onError(error: Error) {
            dbgConnection('Socket error: %s', error);
            _.emit('error', error);
        });
        socket.on('close', function onClose(hadError: boolean) {
            dbgConnection('Socket to %s:%d closed - hadError:%d', _.remoteAddress, _.remotePort, (hadError && 1) || 0);
            _.connected = false;
            _.emit('close', hadError);
        });
    }

    _queueTransfer(transfer: TransferOut) {
        dbgConnection('Queuing transfer');
        // TODO: Throttling?
        var _ = this;
        transfer.on('complete', function onComplete() {
            // Remove the transfer, it is done!
            _.transfersOut.splice(_.transfersOut.indexOf(transfer), 1);
            transfer.removeListener('complete', onComplete);
            // Send a response saying the transfer has ended
            var outBuffer = new Buffer(5);
            outBuffer.writeUInt8(TransferFlags.End, 0);
            outBuffer.writeUInt32BE(transfer.id, 1);
            this.socket.write(outBuffer);
        });
        this.queuedTransfers.push(transfer);

        // Write out a message indicating there is a new transfer ready to be received
        // The other end will generate a transfer id and sent it back
        this.socket.write(this._xferOutStartHeader);
    }

    sendStream(stream: stream.Readable): StreamingTransferOut {
        var transfer = new StreamingTransferOut(stream);
        this._queueTransfer(transfer);
        return transfer;
    }

    sendBuffer(data: NodeBuffer): BufferTransferOut {
        var transfer = new BufferTransferOut(data);
        this._queueTransfer(transfer);
        return transfer;
    }

    close(): void {
        if (this.connected)
            this.socket.end();
    }

    destroy(): void {
        if (this.connected)
            this.socket.destroy();
    }

}

export class Server extends events.EventEmitter {

    port: number;
    server: net.Server;
    connections: { [id: number]: Connection; };
    listening: boolean = false;

    constructor(port?: number) {
        super();
        var _ = this;
        // Start server
        this.port = port || 1337;
        var connections = _.connections = <any>{},
            server = this.server = net.createServer(function onConnection(socket: net.Socket) {
            // Id = random unsigned integer
            var id: number;
            // Make sure its not in use
            while ((id = Math.floor(Math.random() * MAX_UINT_32)) && connections[id])
                continue;
            // Create the connection object
            var connection = connections[id] = new Connection(socket, id, true);
            // Bind
            connection.on('close',function onConnectionClose() {
                // Clear the connection from the array
                delete connections[id];
            });
            // Emit
            _.emit('connection', connection);
        });
        server.on('error', function onError(error: Error) {
            _.emit('error', error);
        });
        server.on('close', function onClose() {
            _.listening = false;
            _.emit('close');
            // TODO: Consider auto-relistening?
        });
    }

    listen() {
        var _ = this;
        this.server.listen(this.port, function onListening() {
            _.listening = true;
            _.emit('listening');
        });
    }

}

export class Client extends Connection {

    address: string;
    port: number;

    connection: Connection;

    constructor(address: string, port?: number) {
        var _ = this;

        this.address = address;
        this.port = port || 1337;

        // Start clients
        var socket = net.connect(this.port, this.address, function onConnected() {
            _.connected = true;
            _.remoteAddress = socket.remoteAddress;
            _.remotePort = socket.remotePort;
            _.remoteFamily = socket.remoteFamily;
            _.emit('connected', _);
        });
        super(socket);

        // TODO: Consider auto-reconnecting on close?
    }

}
