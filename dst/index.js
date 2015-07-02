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
exports.MAX_PACKET_SIZE = 0xFFFF; // 16 bit UINT MAX
var ArrayBufferedStream = (function (_super) {
    __extends(ArrayBufferedStream, _super);
    function ArrayBufferedStream() {
        _super.call(this);
        // By default buffer slicing is off so that we don't screw up message packets and so they don't have to measure their own length
        this.allowSlicing = false;
        this.writable = true;
        this._ended = false;
        this._received = 0;
        this._data = [];
        this._readLimit = 0;
    }
    ArrayBufferedStream.prototype.write = function (data, encodingOrCb, cb) {
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
        this._data.push(data);
        this._received += data.length;
        this._sendData();
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
        this.writable = false;
        this._ended = true;
        // Send any remaining data up to the amount specified by _read if we can
        this._sendData();
    };
    ArrayBufferedStream.prototype._checkEnd = function () {
        if (this._ended && this._data.length === 0) {
            this.push(null);
            return true;
        }
        return false;
    };
    ArrayBufferedStream.prototype._sendData = function () {
        if (this._checkEnd()) {
            return;
        }
        var read = 0;
        var buffer;
        var remaining = Math.max(this._readLimit, 0);
        while (remaining && (buffer = this._data[0])) {
            // TODO: Decide if we should push it all out as we are when slicing is disabled, or wait till remaining is >=
            if (this.allowSlicing && buffer.length > remaining) {
                // cut up the buffer and put the rest back in queue
                this._data[0] = buffer.slice(remaining);
                buffer = buffer.slice(0, remaining);
            }
            else {
                // Remove the buffer from the list
                this._data.shift();
            }
            // Send this buffer
            this.push(buffer);
            read += buffer.length;
            // Update the remaining amount of bytes we should read
            remaining = this._readLimit - read;
        }
        // Update the read limit
        this._readLimit -= read;
        this._checkEnd();
    };
    ArrayBufferedStream.prototype._read = function (size) {
        this._readLimit = size;
        this._sendData();
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
var XFerOutHeader = new Buffer(7);
XFerOutHeader.writeUInt8(16 /* Continue */, 0);
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
        this._xferOutEndHeader = new Buffer(5);
        // 0b00100000 : Transfer end
        this._xferOutEndHeader.writeUInt8(32 /* End */, 0);
        // The last 4 bytes are overwritten by the transfer id of a transfer we need to end
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
                        case 32 /* End */: {
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
                        currentPacketTransfer.write(data.slice(packetOffset, packetOffset + currentPacketBytesRemaining));
                        packetOffset += currentPacketBytesRemaining;
                        bytesRemainingInBuffer -= currentPacketBytesRemaining;
                        // Done with this transfer packet
                        currentPacketTransfer = null;
                        currentPacketLength = currentPacketBytesRemaining = 0;
                        currentPacketFlags = 0;
                    }
                    else if (bytesRemainingInBuffer > 0) {
                        // This may happen frequently with really large transfer blocks
                        // Supply what we can
                        currentPacketTransfer.write(data.slice(packetOffset));
                        currentPacketBytesRemaining -= bytesRemainingInBuffer;
                        break dataLoop;
                    }
                    else {
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
            _._xferOutEndHeader.writeUInt32BE(transfer.id, 1);
            this.socket.write(_._xferOutEndHeader);
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