module.exports = function(RED) {
    "use strict";
    const util = require('util');
    const Client = require('castv2-client').Client;
    const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
    const DefaultMediaReceiverAdapter = require('./lib/DefaultMediaReceiverAdapter');
    const YouTubeReceiver = require('./lib/YouTubeReceiver');
    const YouTubeReceiverAdapter = require('./lib/YouTubeReceiverAdapter');
    
    function CastV2ConnectionNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        // Settings
        this.name = config.name;
        this.host = config.host;
        this.port = config.port;

        // Connection state
        this.connected = false;
        this.connecting = false;
        this.closing = false;

        // Nodes subscribed to this connection
        this.registeredNodes = {};
        this.platformStatus = null;

        // Build connection options
        this.connectOptions = {
            host: this.host,
            port: this.port || 8009
        };
        
        // Platform commands handled by client directly
        this.platformCommands = [
            "CLOSE",
            "GET_VOLUME",
            "GET_CAST_STATUS",
            "MUTE",
            "UNMUTE",
            "VOLUME"
        ];

        /*
         * Launches session
         */
        this.launchAsync = function(castV2App) {
            if (!node.connected) {
                throw new Error("Not connected");
            }

            return node.client.launchAsync(castV2App);
        };

        /*
         * Join session
         */
        this.joinSessionAsync = function(activeSession, castv2App) {
            if (!node.connected) {
                throw new Error("Not connected");
            }

            return node.client.joinAsync(activeSession, castv2App)
        };

        /*
         * Registers a node
         */
        this.register = function(castV2Node) {
            node.registeredNodes[castV2Node.id] = castV2Node;
            if (Object.keys(node.registeredNodes).length === 1) {
                node.connect();
            }
        };

        /*
         * Deregisters a node
         */
        this.deregister = function(castV2Node, done) {
            delete node.registeredNodes[castV2Node.id];
            if (node.closing) {
                return done();
            }

            if (Object.keys(node.registeredNodes).length === 0) {
                if (node.connected || node.connecting) {
                    node.disconnect();
                }
            }

            done();
        };

        /*
         * Call status() on all registered nodes
         */
        this.setStatusOfRegisteredNodes = function(status) {
            for (let id in node.registeredNodes) {
                if (node.registeredNodes.hasOwnProperty(id)) {
                    node.registeredNodes[id].status(status);
                }
            }
        }

        /*
         * Call send() on all registered nodes
         */
        this.sendToRegisteredNodes = function(msg) {
            for (let id in node.registeredNodes) {
                if (node.registeredNodes.hasOwnProperty(id)) {
                    node.registeredNodes[id].send(msg);
                }
            }
        }

        /*
         * Joins all nodes matching current sessions
         */
        this.joinNodes = function() {
            if (!node.connected || !node.platformStatus) {
                throw new Error("Not connected");
            }

            // Update all registered nodes
            for (let id in node.registeredNodes) {
                if (node.registeredNodes.hasOwnProperty(id)) {
                    let activeSession = null;
                    let castV2App = null;
                    if (node.platformStatus.applications) {
                        activeSession = node.platformStatus.applications.find(session => node.registeredNodes[id].supportedApplications.some(supportedApp => supportedApp.APP_ID === session.appId));
                        if (activeSession) {
                            castV2App = node.registeredNodes[id].supportedApplications.find(supportedApp => supportedApp.APP_ID === activeSession.appId);
                        }
                    }

                    if (activeSession && castV2App) {
                        node.registeredNodes[id].join(activeSession, castV2App);
                    } else {
                        node.registeredNodes[id].unjoin();
                    }
                }
            }
        };

        /*
         * Disconnect handler
         */
        this.disconnect = function() {
            if (node.connected || node.connecting) {
                try {
                    node.client.close();
                } catch (exception) {
                    // Swallow close exceptions
                }
            }

            // Reset client
            node.client = null;
            node.platformStatus = null;
            node.connected = false;
            node.connecting = false;

            // Disconnect all active sessions
            for (let id in node.registeredNodes) {
                if (node.registeredNodes.hasOwnProperty(id)) {
                    node.registeredNodes[id].unjoin();
                }
            }

            node.setStatusOfRegisteredNodes({ fill: "red", shape: "ring", text: "disconnected" });
        };

        /*
         * Reconnect handler
         */
        this.reconnect = function() {
            node.connected = false;
            node.connecting = false;

            if (!node.closing && Object.keys(node.registeredNodes).length > 0) {
                clearTimeout(node.reconnectTimeOut);
                node.reconnectTimeOut = setTimeout(() => { node.connect(); }, 3000);    
            }
        };

        /*
         * Connect handler
         */
        this.connect = function() {
            if (!node.connected && !node.connecting) {
                node.reconnectTimeOut = null;
                node.connecting = true;

                try {
                    node.client = new Client();

                    // Setup promisified methods
                    node.client.connectAsync = connectOptions => new Promise(resolve => node.client.connect(connectOptions, resolve));
                    node.client.getAppAvailabilityAsync = util.promisify(node.client.getAppAvailability);
                    node.client.getSessionsAsync = util.promisify(node.client.getSessions);
                    node.client.joinAsync = util.promisify(node.client.join);
                    node.client.launchAsync = util.promisify(node.client.launch);
                    node.client.getStatusAsync = util.promisify(node.client.getStatus);
                    node.client.getVolumeAsync = util.promisify(node.client.getVolume);
                    node.client.setVolumeAsync = util.promisify(node.client.setVolume);
                    node.client.stopAsync = util.promisify(node.client.stop);

                    // Register error handler
                    node.client.once("error", function(error) {
                        node.disconnect();
                        node.reconnect();
                    });

                    // Register disconnect handlers
                    node.client.client.once("close", function() {
                        node.disconnect();
                        node.reconnect();
                    });

                    // Register platform status handler
                    node.client.on("status", function(status) {
                        node.platformStatus = status;
                        node.joinNodes();

                        node.sendToRegisteredNodes({ platform: status });
                    });

                    // Alert connecting state
                    node.setStatusOfRegisteredNodes({ fill: "yellow", shape: "ring", text: "connecting" });

                    // Connect
                    node.client.connectAsync(node.connectOptions)
                        .then(() => {
                            node.connected = true;
                            node.connecting = false;

                            // Set registered node status
                            node.setStatusOfRegisteredNodes({ fill: "green", shape: "ring", text: "connected" });

                            return node.client.getStatusAsync();
                        })
                        .then(status => {
                            node.platformStatus = status;
                            node.joinNodes();

                            node.sendToRegisteredNodes({ platform: status });
                        })
                        .catch(error => {
                            console.log(error);
                            node.disconnect();
                            node.reconnect();
                         });
                } catch (exception) { console.log(exception); }
            }
        };

        /*
         * Close handler
         */
        this.on('close', function(done) {
            node.closing = true;

            node.disconnect();

            done();
        });

        /*
         * Cast command handler
         */
        this.sendPlatformCommandAsync = function(command, receiver) {
            if (!node.connected) {
                throw new Error("Not connected");
            }

            // Check for platform commands first
            switch (command.type) {
                case "CLOSE":
                    if (receiver) {
                        return node.client.stopAsync(receiver);
                    } else {
                        return node.client.getStatusAsync();
                    }
                    break;
                case "GET_VOLUME":
                    return node.client.getVolumeAsync()
                        .then(volume => node.client.getStatusAsync());
                    break;
                case "GET_CAST_STATUS":
                    return node.client.getStatusAsync();
                    break;
                case "MUTE":
                    return node.client.setVolumeAsync({ muted: true })
                        .then(volume => node.client.getStatusAsync());
                    break;
                case "UNMUTE":
                    return node.client.setVolumeAsync({ muted: false })
                        .then(volume => node.client.getStatusAsync());
                    break;
                case "VOLUME":
                    if (command.volume && command.volume >= 0 && command.volume <= 100) {
                        return node.client.setVolumeAsync({ level: command.volume / 100 })
                            .then(volume => node.client.getStatusAsync());
                    } else {
                        throw new Error("Malformed command");
                    }
                    break;
                default:
                    // If it got this far just error
                    throw new Error("Malformed command");
                    break;
            }
        };
    }

    function CastV2SenderNode(config) {
        RED.nodes.createNode(this, config);

        // Settings
        this.name = config.name;
        this.connection = config.connection;
        this.clientNode = RED.nodes.getNode(this.connection);

        // Internal state
        this.supportedApplications = [ DefaultMediaReceiver, YouTubeReceiver ];
        this.receiver = null;
        this.adapter = null;

        // Media control commands handled by any active receiver
        this.mediaCommands = [
            "GET_STATUS",
            "PAUSE",
            "PLAY",
            "SEEK",
            "STOP"
        ];
        
        let node = this;

        /*
         * Joins this node to the active receiver on the client connection
         */
        this.join = function(activeSession, castV2App) {
            node.clientNode.joinSessionAsync(activeSession, castV2App)
                .then(receiver => node.initReceiver(receiver, castV2App));
        };

        /*
         * Disconnects this node from the active receiver on the client connection
         */
        this.unjoin = function() {
            node.adapter = null;
            node.receiver = null;
            node.status({ fill: "green", shape: "ring", text: "connected" });
        };

        /*
         * Initializes a receiver after launch or join
         */
        this.initReceiver = function(receiver, castV2App) {
            node.adapter = node.getAdapter(castV2App);
            node.receiver = node.adapter.initReceiver(node, receiver);

            node.receiver.on("status", function(status) {
                node.send({ payload: status });
            });
    
            node.receiver.once("close", function() {
                node.adapter = null;
                node.receiver = null;
                node.status({ fill: "green", shape: "ring", text: "connected" });
            });
    
            node.status({ fill: "green", shape: "dot", text: "joined" });
        };

        /*
         * Gets adapter for specified application
         */
        this.getAdapter = function(castV2App) {
            switch (castV2App.APP_ID) {
                case DefaultMediaReceiver.APP_ID:
                    return DefaultMediaReceiverAdapter;
                    break;
                case YouTubeReceiver.APP_ID:
                    return YouTubeReceiverAdapter;
                    break;
                default:
                    return null;
                    break;
            }
        }

        /*
         * Gets application for command
         */
        this.getCommandApp = function(command) {
            switch (command.app) {
                case "DefaultMediaReceiver":
                    return DefaultMediaReceiver;
                    break;
                case "YouTube":
                    return YouTubeReceiver;
                    break;
                default:
                    return null;
                    break;
            }
        }

        /*
         * General command handler
         */
        this.sendCommandAsync = function(command) {
            let isPlatformCommand = node.clientNode.platformCommands.includes(command.type);
            if (isPlatformCommand) {
                return node.clientNode.sendPlatformCommandAsync(command, node.receiver);
            } else {
                // If not active, launch and try again
                if (!node.receiver || !node.adapter) {
                    // Route to app
                    let castV2App = node.getCommandApp(command);

                    return node.clientNode.launchAsync(castV2App)
                        .then(receiver => {
                            node.initReceiver(receiver, castV2App);
                            return node.sendCommandAsync(command);
                        });
                }

                let isMediaCommand = node.mediaCommands.includes(command.type);
                if (isMediaCommand) {
                    return node.sendMediaCommandAsync(command);
                } else {
                    return node.adapter.sendAppCommandAsync(node.receiver, command);
                }
            }
        };

        /*
         * Media command handler
         */
        this.sendMediaCommandAsync = function(command) {
            if (command.type === "GET_STATUS") {
                return node.receiver.getStatusAsync();
            } else {
                // Initialize media controller by calling getStatus first
                return node.receiver.getStatusAsync()
                    .then(status => {
                        // Theres not actually anything playing, exit gracefully
                        if (!status) throw new Error("not playing");

                        /*
                        * Execute media control command
                        * status.supportedMediaCommands bitmask
                        * 1     Pause
                        * 2     Seek
                        * 4     Stream volume
                        * 8     Stream mute
                        * 16    Skip forward
                        * 32    Skip backward
                        * 64    Queue Next
                        * 128   Queue Prev
                        * 256   Queue Shuffle
                        * 1024  Queue Repeat All
                        * 2048  Queue Repeat One
                        * 3072  Queue Repeat
                        */
                        switch (command.type) {
                            case "PAUSE":
                                if (status.supportedMediaCommands & 1) {
                                    return node.receiver.pauseAsync();
                                }
                                break;
                            case "PLAY":
                                return node.receiver.playAsync();
                                break;
                            case "SEEK":
                                if (command.time && status.supportedMediaCommands & 2) {
                                    return node.receiver.seekAsync(command.time);
                                }
                                break;
                            case "STOP":
                                return node.receiver.stopAsync();
                                break;
                            default:
                                throw new Error("Malformed media control command");
                                break;
                        }
                    });
            }
        };

        if (node.clientNode) {
            node.status({ fill: "red", shape: "ring", text: "disconnected" });
            node.clientNode.register(node);

            if (node.clientNode.connected) {
                node.status({ fill: "green", shape: "ring", text: "connected" });
            }

            /*
            * Node-red input handler
            */
            this.on("input", function(msg, send, done) {
                // For maximum backwards compatibility, check that send exists.
                // If this node is installed in Node-RED 0.x, it will need to
                // fallback to using `node.send`
                send = send || function() { node.send.apply(node, arguments); };

                const errorHandler = function(error) {
                    node.status({ fill: "red", shape: "ring", text: "error" });
    
                    if (done) { 
                        done(error);
                    } else {
                        node.error(error, error.message);
                    }
                };

                try {
                    // Validate incoming message
                    if (msg.payload == null || typeof msg.payload !== "object") {
                        msg.payload = { type: "GET_CAST_STATUS" };
                    }

                    if (msg.payload.app == null) {
                        msg.payload.app = "DefaultMediaReceiver";
                    }

                    node.sendCommandAsync(msg.payload)
                        .then(status => { 
                            if (done) done();
                        })
                        .catch(error => errorHandler(error));
                } catch (exception) { errorHandler(exception); }
            });

            /*
            * Node-red close handler
            */
            this.on('close', function(done) {
                if (node.clientNode) {
                    node.clientNode.deregister(node, function() {
                        node.adapter = null;
                        node.receiver = null;
                        done();
                    });
                } else {
                    done();
                }
            });
        } else {
            node.status({ fill: "red", shape: "ring", text: "unconfigured" });
        }
    }

    RED.nodes.registerType("castv2-connection", CastV2ConnectionNode);
    RED.nodes.registerType("castv2-sender", CastV2SenderNode);
}