/// <reference path="../lib/node.d.ts" />
var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
var stream = require('stream');
var events = require('events');
var net = require('net');
var debug = require('./debug');
exports.MAX_SAFE_INT = 9007199254740991;
exports.MAX_UINT_32 = 0xFFFFFFFF;
exports.MAX_PACKET_SIZE = 1400; // 1500 is the max ethernet mtu, 1400 gives us enough room for underlying protocols and our headers to avoid packet loss and corruption
var EMPTY_BUFFER = new Buffer(0);
var dbgArrayBufferedStream = debug('ArrayBufferedStream');
var ArrayBufferedStream = (function (_super) {
    __extends(ArrayBufferedStream, _super);
    function ArrayBufferedStream() {
        // Specify that this should buffer lots of data 4GB
        _super.call(this, {
            highWaterMark: exports.MAX_UINT_32
        });
        // By default buffer slicing is off so that we don't screw up message packets and so they don't have to measure their own length
        this.writable = true;
        this._ended = false;
        this._received = 0;
    }
    ArrayBufferedStream.prototype.write = function (data, encodingOrCb, cb) {
        if (this._ended) {
            cb && setImmediate(cb);
            return;
        }
        var encoding = 'utf8';
        if (typeof encodingOrCb === 'function') {
            cb = encodingOrCb;
        }
        else if (typeof encodingOrCb === 'string') {
            encoding = encoding;
        }
        if (typeof data === 'string') {
            data = new Buffer(data, encoding);
        }
        dbgArrayBufferedStream('Adding %d bytes of data', data.length);
        this.push(data);
        this._received += data.length;
        cb && setImmediate(cb);
        return true;
    };
    ArrayBufferedStream.prototype.end = function (data, encodingOrCb, cb) {
        if (this._ended) {
            cb && setImmediate(cb);
            return;
        }
        if (data) {
            this.write(data, encodingOrCb, cb);
        }
        dbgArrayBufferedStream('Ending stream');
        this.writable = false;
        this._ended = true;
        this.push(null);
    };
    ArrayBufferedStream.prototype._read = function (size) {
        // Do nothing, this stream relies on the underlying readable, with an extremely high watermark
    };
    return ArrayBufferedStream;
})(stream.Readable);
exports.ArrayBufferedStream = ArrayBufferedStream;
var dbgTransferIn = debug('TransferIn');
// TODO: Limit the amount this buffers or else we will run out of the memory
var TransferIn = (function (_super) {
    __extends(TransferIn, _super);
    function TransferIn(id) {
        _super.call(this);
        this.id = id;
        dbgTransferIn('Starting inbound transfer %d.', this.id);
    }
    return TransferIn;
})(ArrayBufferedStream);
exports.TransferIn = TransferIn;
var dbgTransferOut = debug('TransferOut');
var TransferOut = (function (_super) {
    __extends(TransferOut, _super);
    function TransferOut() {
        _super.apply(this, arguments);
    }
    TransferOut.prototype.start = function (id, socket) {
        this.id = id;
        this.socket = socket;
        this.transfer();
        this.emit('started');
        dbgTransferOut('Started outbound transfer %d', id);
    };
    TransferOut.prototype.sendData = function (buffer, cb) {
        dbgTransferOut('Continuing outbound transfer %d, sending %d bytes.', this.id, buffer.length);
        var outBuffer = new Buffer(7 + buffer.length);
        // Write flags
        outBuffer.writeUInt8(16 /* Continue */, 0);
        // Write transfer id
        outBuffer.writeUInt32BE(this.id, 1);
        // Write packet length
        outBuffer.writeUInt16BE(buffer.length, 5);
        // Write out buffer
        buffer.copy(outBuffer, 7, 0, buffer.length);
        this.socket.write(outBuffer, cb);
    };
    TransferOut.prototype.transfer = function () {
        throw new Error('transfer() not yet implemented in derived class of TransferOut!');
    };
    return TransferOut;
})(events.EventEmitter);
exports.TransferOut = TransferOut;
var BufferTransferOut = (function (_super) {
    __extends(BufferTransferOut, _super);
    function BufferTransferOut(data) {
        _super.call(this);
        this.data = data;
    }
    BufferTransferOut.prototype.transfer = function () {
        var _ = this;
        var outData = _.data;
        var started = 0;
        var sent = 0;
        while (outData.length) {
            // Split into parts based on the max packet size
            var bytesInPart = Math.min(outData.length, exports.MAX_PACKET_SIZE);
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
    };
    return BufferTransferOut;
})(TransferOut);
exports.BufferTransferOut = BufferTransferOut;
var StreamingTransferOut = (function (_super) {
    __extends(StreamingTransferOut, _super);
    function StreamingTransferOut(stream) {
        _super.call(this);
        this.stream = stream;
        this.stream.pause();
        this._packetsPushed = 0;
        this._packetsSent = 0;
        this._ended = false;
    }
    StreamingTransferOut.prototype.transfer = function () {
        var _ = this;
        _.stream.resume();
        function onData(data) {
            _._packetsPushed++;
            var outData = data;
            while (outData.length) {
                // Split into parts based on the max packet size
                var bytesInPart = Math.min(outData.length, exports.MAX_PACKET_SIZE);
                var part = outData.slice(0, bytesInPart);
                // Update outData for next iteration
                outData = outData.slice(bytesInPart);
                // Send the part
                _.sendData(part, function completeCheck() {
                    _._packetsSent++;
                    if (_._ended && _._packetsPushed === _._packetsSent) {
                        _.emit('complete');
                        dbgTransferOut('Completed outbound transfer %d.', _.id);
                    }
                });
            }
        }
        _.stream.on('data', onData);
        _.stream.once('end', function onEnd() {
            // All done!
            _.stream.removeListener('data', onData);
            _._ended = true;
            if (_._packetsPushed === _._packetsSent) {
                _.emit('complete');
                dbgTransferOut('Completed outbound transfer %d.', _.id);
            }
        });
    };
    return StreamingTransferOut;
})(TransferOut);
exports.StreamingTransferOut = StreamingTransferOut;
var TransferFlags;
(function (TransferFlags) {
    TransferFlags[TransferFlags["Start"] = 128] = "Start";
    TransferFlags[TransferFlags["Ack"] = 64] = "Ack";
    TransferFlags[TransferFlags["End"] = 32] = "End";
    TransferFlags[TransferFlags["Continue"] = 16] = "Continue"; // Normal transfer continuation
})(TransferFlags || (TransferFlags = {}));
var dbgConnection = debug('Connection');
var Connection = (function (_super) {
    __extends(Connection, _super);
    function Connection(socket, id, connected) {
        _super.call(this);
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
        this._xferOutStartHeader.writeUInt8(128 /* Start */, 0);
        var _ = this;
        // Bind to process data-packets
        var packetInTransit = false;
        var currentPacketFlags = 0;
        var currentPacketHeaderResolved = false;
        var currentPacketLength = 0;
        var currentPacketTransfer = null;
        var currentPacketBytesRemaining = 0;
        var packetTrimmings = null;
        var transferResponseHeader = new Buffer(5);
        // 0b01000000 : Transfer ack
        transferResponseHeader.writeInt8(64 /* Ack */, 0);
        // Next 4 Bytes are reserved for transfer id
        socket.on('data', function onData(data) {
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
            var xferId;
            var xferIn;
            dataLoop: while (true) {
                // Loop must continue until explicitly exited
                bytesRemainingInBuffer = data.length - packetOffset;
                dbgConnection('Processing buffer remaining bytes (%d) expected in packet (%d)', bytesRemainingInBuffer, currentPacketBytesRemaining);
                if (currentPacketFlags && !currentPacketHeaderResolved) {
                    switch (currentPacketFlags) {
                        case 128 /* Start */: {
                            while ((xferId = Math.floor(Math.random() * exports.MAX_UINT_32)) && _.transfersIn[xferId])
                                continue;
                            xferIn = _.transfersIn[xferId] = new TransferIn(xferId);
                            dbgConnection('New transfer id (%d)', xferId);
                            // Return the assigned transferId, Acking this transfer
                            transferResponseHeader.writeUInt32BE(xferId, 1);
                            socket.write(transferResponseHeader);
                            _.emit('transfer', xferIn);
                            break;
                        }
                        case 64 /* Ack */: {
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
                        case 32 /* End */: {
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
                            }
                            else {
                                dbgConnection('Error, could not end non existent inbound transfer: %d', xferId);
                            }
                            break;
                        }
                        case 16 /* Continue */: {
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
                    }
                    else if (bytesRemainingInBuffer > 0) {
                        dbgConnection('Continuing transfer id (%d) received (%d) adding (%d) unsatisfied', currentPacketTransfer.id, currentPacketTransfer._received, bytesRemainingInBuffer);
                        // This may happen frequently with really large transfer blocks
                        // Supply what we can
                        currentPacketTransfer.write(data.slice(packetOffset));
                        currentPacketBytesRemaining -= bytesRemainingInBuffer;
                        break dataLoop;
                    }
                    else {
                        dbgConnection('Continuing transfer id (%d) received (%d) WARNING No bytes provided?..', currentPacketTransfer.id, currentPacketTransfer._received);
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
                }
                else {
                    break dataLoop;
                }
            }
            dbgConnection('Done processing buffer, length %d bytes', data.length);
        });
        // Bubble events:
        socket.on('error', function onError(error) {
            _.emit('error', error);
        });
        socket.on('close', function onClose(hadError) {
            _.connected = false;
            _.emit('close', hadError);
        });
    }
    Connection.prototype._queueTransfer = function (transfer) {
        dbgConnection('Queuing transfer');
        // TODO: Throttling?
        var _ = this;
        transfer.on('complete', function onComplete() {
            // Remove the transfer, it is done!
            _.transfersOut.splice(_.transfersOut.indexOf(transfer), 1);
            transfer.removeListener('complete', onComplete);
            // Send a response saying the transfer has ended
            var outBuffer = new Buffer(5);
            outBuffer.writeUInt8(32 /* End */, 0);
            outBuffer.writeUInt32BE(transfer.id, 1);
            this.socket.write(outBuffer);
        });
        this.queuedTransfers.push(transfer);
        // Write out a message indicating there is a new transfer ready to be received
        // The other end will generate a transfer id and sent it back
        this.socket.write(this._xferOutStartHeader);
    };
    Connection.prototype.sendStream = function (stream) {
        var transfer = new StreamingTransferOut(stream);
        this._queueTransfer(transfer);
        return transfer;
    };
    Connection.prototype.sendBuffer = function (data) {
        var transfer = new BufferTransferOut(data);
        this._queueTransfer(transfer);
        return transfer;
    };
    Connection.prototype.close = function () {
        if (this.connected)
            this.socket.end();
    };
    Connection.prototype.destroy = function () {
        if (this.connected)
            this.socket.destroy();
    };
    return Connection;
})(events.EventEmitter);
exports.Connection = Connection;
var Server = (function (_super) {
    __extends(Server, _super);
    function Server(port) {
        _super.call(this);
        this.listening = false;
        var _ = this;
        // Start server
        this.port = port || 1337;
        var connections = _.connections = {}, server = this.server = net.createServer(function onConnection(socket) {
            // Id = random unsigned integer
            var id;
            while ((id = Math.floor(Math.random() * exports.MAX_UINT_32)) && connections[id])
                continue;
            // Create the connection object
            var connection = connections[id] = new Connection(socket, id, true);
            // Bind
            connection.on('close', function onConnectionClose() {
                // Clear the connection from the array
                delete connections[id];
            });
            // Emit
            _.emit('connection', connection);
        });
        server.on('error', function onError(error) {
            _.emit('error', error);
        });
        server.on('close', function onClose() {
            _.listening = false;
            _.emit('close');
            // TODO: Consider auto-relistening?
        });
    }
    Server.prototype.listen = function () {
        var _ = this;
        this.server.listen(this.port, function onListening() {
            _.listening = true;
            _.emit('listening');
        });
    };
    return Server;
})(events.EventEmitter);
exports.Server = Server;
var Client = (function (_super) {
    __extends(Client, _super);
    function Client(address, port) {
        var _ = this;
        this.address = address;
        this.port = port || 1337;
        // Start clients
        _super.call(this, net.connect(this.port, this.address, function onConnected() {
            _.connected = true;
            _.emit('connected', _);
        }));
        // TODO: Consider auto-reconnecting on close?
    }
    return Client;
})(Connection);
exports.Client = Client;
//# sourceMappingURL=index.js.map