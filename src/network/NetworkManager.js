// PeerPigeon is loaded globally from browser bundle
// PigeonMatch is loaded as ES module
import { MatchmakingEngine, MatchmakingEvent } from 'pigeonmatch';

const { PeerPigeonMesh } = window;

/**
 * Network Manager for multiplayer functionality
 * Handles peer connections and player synchronization
 */
export class NetworkManager {
    constructor() {
        this.mesh = null;
        this.matchmaker = null;
        this.peerId = null;
        this.peers = new Map();
        this.players = new Map();
        this.eventHandlers = new Map();
        this.connected = false;
        this.worldId = 'pigeonworld-main'; // Shared world instance
    }

    /**
     * Initialize the network connection
     */
    async init() {
        try {
            console.log('Initializing PeerPigeon mesh network...');
            
            // Initialize PeerPigeon mesh
            this.mesh = new PeerPigeonMesh({
                enableWebDHT: true,
                peerId: this.generatePeerId()
            });

            await this.mesh.init();
            this.peerId = this.mesh.peerId;
            
            console.log(`Initialized with Peer ID: ${this.peerId}`);

            // Connect to signaling server
            await this.mesh.connect('wss://pigeonhub.fly.dev');
            
            console.log('Connected to signaling server');

            // Initialize PigeonMatch matchmaking engine
            this.matchmaker = new MatchmakingEngine({
                maxPeers: 100,
                namespace: this.worldId,
                matchTimeout: 30000,
                mesh: this.mesh
            });

            // Set up matchmaking event handlers
            this.matchmaker.on(MatchmakingEvent.MATCH_FOUND, (match) => {
                console.log('Match found:', match);
            });

            this.matchmaker.on(MatchmakingEvent.PEER_JOINED, (peer) => {
                console.log('Peer joined match:', peer);
            });

            console.log('PigeonMatch initialized');

            // Join or create world instance
            await this.joinWorld();

            // Set up message handlers
            this.setupMessageHandlers();

            this.connected = true;
            console.log('Network initialization complete');

            return true;
        } catch (error) {
            console.error('Failed to initialize network:', error);
            // Continue in offline mode
            this.connected = false;
            return false;
        }
    }

    /**
     * Generate a unique peer ID
     */
    generatePeerId() {
        return 'player-' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Join or create a world instance
     */
    async joinWorld() {
        try {
            console.log(`Joining world: ${this.worldId}`);
            
            // Announce presence to other peers in the mesh
            this.broadcast({
                type: 'player-join',
                peerId: this.peerId,
                timestamp: Date.now()
            });

            console.log('Joined world successfully');
        } catch (error) {
            console.error('Failed to join world:', error);
        }
    }

    /**
     * Set up message handlers for incoming messages
     */
    setupMessageHandlers() {
        if (!this.mesh) return;

        // Listen for messages from other peers
        this.mesh.on('message', (data) => {
            this.handleMessage(data);
        });

        // Listen for peer connections
        this.mesh.on('peer-connected', (peerId) => {
            console.log('Peer connected:', peerId);
            this.peers.set(peerId, { id: peerId, connectedAt: Date.now() });
            this.emit('peer-connected', peerId);
        });

        // Listen for peer disconnections
        this.mesh.on('peer-disconnected', (peerId) => {
            console.log('Peer disconnected:', peerId);
            this.peers.delete(peerId);
            this.players.delete(peerId);
            this.emit('peer-disconnected', peerId);
        });
    }

    /**
     * Handle incoming messages
     */
    handleMessage(data) {
        if (!data || !data.type) return;

        switch (data.type) {
            case 'player-join':
                this.handlePlayerJoin(data);
                break;
            case 'player-update':
                this.handlePlayerUpdate(data);
                break;
            case 'player-leave':
                this.handlePlayerLeave(data);
                break;
            case 'world-update':
                this.handleWorldUpdate(data);
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    }

    /**
     * Handle player join event
     */
    handlePlayerJoin(data) {
        console.log('Player joined:', data.peerId);
        this.players.set(data.peerId, {
            id: data.peerId,
            x: 0,
            y: 0,
            joinedAt: data.timestamp
        });
        this.emit('player-joined', data.peerId);

        // Send our current state to the new player
        if (this.localPlayer) {
            this.sendPlayerUpdate(this.localPlayer);
        }
    }

    /**
     * Handle player update event
     */
    handlePlayerUpdate(data) {
        if (data.peerId === this.peerId) return; // Ignore own updates

        const player = this.players.get(data.peerId) || { id: data.peerId };
        Object.assign(player, data.state);
        this.players.set(data.peerId, player);
        
        this.emit('player-updated', player);
    }

    /**
     * Handle player leave event
     */
    handlePlayerLeave(data) {
        console.log('Player left:', data.peerId);
        this.players.delete(data.peerId);
        this.emit('player-left', data.peerId);
    }

    /**
     * Handle world update event
     */
    handleWorldUpdate(data) {
        this.emit('world-updated', data);
    }

    /**
     * Send player position update
     */
    sendPlayerUpdate(player) {
        if (!this.connected) return;

        this.broadcast({
            type: 'player-update',
            peerId: this.peerId,
            state: {
                x: player.x,
                y: player.y,
                vx: player.vx || 0,
                vy: player.vy || 0
            },
            timestamp: Date.now()
        });
    }

    /**
     * Broadcast message to all peers
     */
    async broadcast(message) {
        if (!this.mesh || !this.connected) return;

        try {
            await this.mesh.sendMessage(JSON.stringify(message));
        } catch (error) {
            console.error('Failed to broadcast message:', error);
        }
    }

    /**
     * Event emitter functionality
     */
    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event).push(handler);
    }

    emit(event, data) {
        const handlers = this.eventHandlers.get(event) || [];
        handlers.forEach(handler => handler(data));
    }

    /**
     * Get connected peer count
     */
    getPeerCount() {
        return this.peers.size;
    }

    /**
     * Get all players
     */
    getPlayers() {
        return Array.from(this.players.values());
    }

    /**
     * Store local player reference
     */
    setLocalPlayer(player) {
        this.localPlayer = player;
    }

    /**
     * Disconnect from network
     */
    async disconnect() {
        if (!this.connected) return;

        console.log('Disconnecting from network...');
        
        // Announce leave
        this.broadcast({
            type: 'player-leave',
            peerId: this.peerId,
            timestamp: Date.now()
        });

        // Cleanup
        if (this.matchmaker) {
            this.matchmaker.destroy();
        }

        if (this.mesh) {
            await this.mesh.disconnect();
        }

        this.connected = false;
        this.peers.clear();
        this.players.clear();
        
        console.log('Disconnected from network');
    }
}
