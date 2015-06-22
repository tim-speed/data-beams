/// <reference path="../lib/node.d.ts" />

import stream = require('stream');
import events = require('events');
import net = require('net');

var debug = require('./debug');

export var MAX_SAFE_INT = 9007199254740991;
export var MAX_UINT_32 = 0xFFFFFFFF;
export var MAX_PACKET_SIZE = 0xFFFF; // 16 bit UINT MAX

var dbgTransferIn = debug('TransferIn');

// TODO: Limit the amount this buffers or else we will run out of the memory
export class TransferIn extends stream.Readable {

    id: number;
    complete: boolean;

    _received: number;
    _push: (chunk: any, encoding?: string) => boolean;
    _data: NodeBuffer[];
    _readLimit: number;

    constructor(id: number) {
        super();

        this.id = id;
        this.complete = false;

        this._received = 0;
        this._data = [];
        this._readLimit = 0;
        this._push = this.push;
        this.push = this.addData;
        dbgTransferIn('Starting inbound transfer %d.', this.id);
    }

    addData(data: NodeBuffer): boolean {
        if (this.complete)
            return false;
        this._data.push(data);
        this._received += data.length;
        dbgTransferIn('Continuing inbound transfer %d, received %d bytes (total %d).', this.id, data.length, this._received);
        this.sendData();
        return true;
    }

    sendData() {
        var read = 0;
        var buffer: NodeBuffer;
        var remaining = this._readLimit;

        while (remaining && (buffer = this._data[0])) {
            if (buffer.length > remaining) {
                // cut up the buffer and put the rest back in queue
                this._data[0] = buffer.slice(remaining);
                buffer = buffer.slice(0, remaining);
            } else {
                // Remove the buffer from the list
                this._data.shift();
            }

            // Send this buffer
            this._push(buffer);
            read += buffer.length;

            // Update the remaining amount of bytes we should read
            remaining = this._readLimit - read;
        }
        dbgTransferIn('Reading inbound transfer %d, requested %d bytes (provided %d).', this.id, this._readLimit, read);
        // Update the read limit
        this._readLimit -= read;
    }

    _read(size: number) {
        this._readLimit = size;
        this.sendData();
    }

    end(): void {
        this._push(null);
        dbgTransferIn('Ending inbound transfer %d.', this.id);
    }

}

var XFerOutHeader = new Buffer(7);
XFerOutHeader.writeUInt8(TransferFlags.Continue, 0);

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
        var _ = this;
        setImmediate(function sendData() {
            dbgTransferOut('Continuing outbound transfer %d, sending %d bytes.', _.id, buffer.length);
            // Write transfer id
            XFerOutHeader.writeUInt32BE(_.id, 1);
            // Write packet length
            XFerOutHeader.writeUInt16BE(buffer.length, 5);
            _.socket.write(XFerOutHeader);
            _.socket.write(buffer);
            cb && cb();
        });
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
                    dbgTransferOut('Completed outbound transfer %d.', _.id);
                }
            });
            started++;
        }
    }

}

export class StreamingTransferOut extends TransferOut {

    stream: stream.Readable;

    constructor(stream: stream.Readable) {
        super();
        this.stream = stream;
        this.stream.pause();
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
                // Update outData for next iteration
                outData = outData.slice(bytesInPart);
                // Send the part
                _.sendData(part);
            }
        }
        _.stream.on('data', onData);
        _.stream.once('end', function onEnd() {
            // All done!
            _.stream.removeListener('data', onData);
            _.emit('complete');
            dbgTransferOut('Completed outbound transfer %d.', _.id);
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
    _xferOutEndHeader: NodeBuffer;

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

        this._xferOutEndHeader = new Buffer(5);
        // 0b00100000 : Transfer end
        this._xferOutEndHeader.writeUInt8(TransferFlags.End, 0);
        // The last 4 bytes are overwritten by the transfer id of a transfer we need to end

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
                                    // Subtract one from offset for the flags, because we will need to reconsume them
                                    dbgConnection('Storing packet trimmings, %d bytes', bytesRemainingInBuffer - 1);
                                    packetTrimmings = data.slice(packetOffset - 1);
                                }
                                break dataLoop;
                            }

                            // Start our outbound transfer
                            xferId = data.readUInt32BE(packetOffset);
                            dbgConnection('Read transfer id (%d)', xferId);
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
                                    // Subtract one from offset for the flags, because we will need to reconsume them
                                    dbgConnection('Storing packet trimmings, %d bytes', bytesRemainingInBuffer - 1);
                                    packetTrimmings = data.slice(packetOffset - 1);
                                }
                                break dataLoop;
                            }

                            // End a running transfer
                            xferId = data.readUInt32BE(packetOffset);
                            dbgConnection('Read transfer id (%d)', xferId);
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
                                    // Subtract one from offset for the flags, because we will need to reconsume them
                                    dbgConnection('Storing packet trimmings, %d bytes', bytesRemainingInBuffer - 1);
                                    packetTrimmings = data.slice(packetOffset - 1);
                                }
                                break dataLoop;
                            }

                            // Handle incoming packet data for transfer
                            xferId = data.readUInt32BE(packetOffset);
                            dbgConnection('Read transfer id (%d)', xferId);
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
                            throw new Error('Error, invalid packet flags: ' + currentPacketFlags);
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
                    dbgConnection('Continuing transfer id (%d) received (%d)', currentPacketTransfer.id, currentPacketTransfer._received);
                    // Take as much data from "data" as we can or until our length is satisfied
                    if (bytesRemainingInBuffer >= currentPacketBytesRemaining) {
                        // This may happen frequently with small transfer blocks
                        currentPacketTransfer.addData(data.slice(packetOffset, packetOffset + currentPacketBytesRemaining));
                        packetOffset += currentPacketBytesRemaining;
                        bytesRemainingInBuffer -= currentPacketBytesRemaining;
                        // Done with this transfer packet
                        currentPacketTransfer = null;
                        currentPacketLength = currentPacketBytesRemaining = 0;
                        currentPacketFlags = 0;
                    } else if (bytesRemainingInBuffer > 0) {
                        // This may happen frequently with really large transfer blocks
                        // Supply what we can
                        currentPacketTransfer.addData(data.slice(packetOffset));
                        currentPacketBytesRemaining -= bytesRemainingInBuffer;
                        // Maxed out buffer, continue at next packet
                        break dataLoop;
                    } else {
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
            _.emit('error', error);
        });
        socket.on('close', function onClose(hadError: boolean) {
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
            _._xferOutEndHeader.writeUInt32BE(transfer.id, 1);
            this.socket.write(_._xferOutEndHeader);
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
        super(net.connect(this.port, this.address, function onConnected() {
            _.connected = true;
            _.emit('connected', _);
        }));

        // TODO: Consider auto-reconnecting on close?
    }

}
