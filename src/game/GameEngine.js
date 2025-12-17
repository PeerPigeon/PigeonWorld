import { WorldGenerator } from '../world/WorldGenerator.js';
import { NetworkManager } from '../network/NetworkManager.js';

/**
 * Main game engine
 * Handles rendering, player movement, and game loop
 */
export class GameEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.worldGen = new WorldGenerator();
        this.network = new NetworkManager();
        
        // Camera
        this.camera = {
            x: 0,
            y: 0,
            zoom: 1
        };

        // Local player
        this.player = {
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            speed: 0.15,
            size: 20,
            color: '#FF5722'
        };

        // Remote players
        this.remotePlayers = new Map();

        // Chunk cache
        this.chunks = new Map();
        this.visibleChunks = new Set();

        // Input state
        this.keys = {};
        this.lastUpdate = Date.now();
        this.lastNetworkUpdate = Date.now();

        // UI update callbacks
        this.uiCallbacks = {
            position: null,
            chunk: null,
            peers: null,
            players: null,
            status: null
        };

        // Game state
        this.running = false;
        this.initialized = false;
    }

    /**
     * Initialize the game
     */
    async init() {
        console.log('Initializing game engine...');

        // Set up canvas
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());

        // Set up input handlers
        this.setupInputHandlers();

        // Initialize network
        const networkSuccess = await this.network.init();
        
        if (networkSuccess) {
            this.updateUI('status', 'Connected');
            this.network.setLocalPlayer(this.player);
            
            // Set up network event handlers
            this.setupNetworkHandlers();
        } else {
            this.updateUI('status', 'Offline Mode');
        }

        // Set initial camera position
        this.camera.x = this.player.x;
        this.camera.y = this.player.y;

        this.initialized = true;
        console.log('Game engine initialized');
    }

    /**
     * Setup network event handlers
     */
    setupNetworkHandlers() {
        this.network.on('player-joined', (peerId) => {
            console.log('Remote player joined:', peerId);
        });

        this.network.on('player-updated', (player) => {
            this.remotePlayers.set(player.id, player);
            this.updateUI('players', this.remotePlayers.size);
        });

        this.network.on('player-left', (peerId) => {
            this.remotePlayers.delete(peerId);
            this.updateUI('players', this.remotePlayers.size);
        });

        this.network.on('peer-connected', () => {
            this.updateUI('peers', this.network.getPeerCount());
        });

        this.network.on('peer-disconnected', () => {
            this.updateUI('peers', this.network.getPeerCount());
        });
    }

    /**
     * Resize canvas to fit window
     */
    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    /**
     * Set up keyboard input handlers
     */
    setupInputHandlers() {
        window.addEventListener('keydown', (e) => {
            this.keys[e.key.toLowerCase()] = true;
            
            // Prevent default for game keys
            if (['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) {
                e.preventDefault();
            }
        });

        window.addEventListener('keyup', (e) => {
            this.keys[e.key.toLowerCase()] = false;
        });
    }

    /**
     * Start the game loop
     */
    start() {
        if (this.running) return;
        this.running = true;
        this.gameLoop();
    }

    /**
     * Main game loop
     */
    gameLoop() {
        if (!this.running) return;

        const now = Date.now();
        const deltaTime = now - this.lastUpdate;
        this.lastUpdate = now;

        // Update game state
        this.update(deltaTime, now);

        // Render
        this.render();

        // Continue loop
        requestAnimationFrame(() => this.gameLoop());
    }

    /**
     * Update game state
     */
    update(deltaTime, now) {
        // Update player movement
        this.updatePlayer(deltaTime);

        // Update camera
        this.updateCamera();

        // Update visible chunks
        this.updateVisibleChunks();

        // Send player update to network (throttled to ~20 updates per second)
        const timeSinceLastNetworkUpdate = now - this.lastNetworkUpdate;
        if (timeSinceLastNetworkUpdate > 50) {
            this.network.sendPlayerUpdate(this.player);
            this.lastNetworkUpdate = now;
        }

        // Update UI
        this.updateUI('position', `${Math.floor(this.player.x)}, ${Math.floor(this.player.y)}`);
        const chunkX = Math.floor(this.player.x / this.worldGen.chunkSize);
        const chunkY = Math.floor(this.player.y / this.worldGen.chunkSize);
        this.updateUI('chunk', `${chunkX}, ${chunkY}`);
    }

    /**
     * Update player position based on input
     */
    updatePlayer(deltaTime) {
        const speed = this.player.speed * deltaTime;

        // Reset velocity
        this.player.vx = 0;
        this.player.vy = 0;

        // WASD movement
        if (this.keys['w'] || this.keys['arrowup']) this.player.vy -= speed;
        if (this.keys['s'] || this.keys['arrowdown']) this.player.vy += speed;
        if (this.keys['a'] || this.keys['arrowleft']) this.player.vx -= speed;
        if (this.keys['d'] || this.keys['arrowright']) this.player.vx += speed;

        // Normalize diagonal movement
        if (this.player.vx !== 0 && this.player.vy !== 0) {
            const magnitude = Math.sqrt(this.player.vx * this.player.vx + this.player.vy * this.player.vy);
            this.player.vx = (this.player.vx / magnitude) * speed;
            this.player.vy = (this.player.vy / magnitude) * speed;
        }

        // Update position
        const newX = this.player.x + this.player.vx;
        const newY = this.player.y + this.player.vy;

        // Check if new position is walkable
        const tile = this.worldGen.getTileAt(Math.floor(newX), Math.floor(newY));
        if (tile && tile.walkable) {
            this.player.x = newX;
            this.player.y = newY;
        }
    }

    /**
     * Update camera to follow player
     */
    updateCamera() {
        const smoothing = 0.1;
        this.camera.x += (this.player.x - this.camera.x) * smoothing;
        this.camera.y += (this.player.y - this.camera.y) * smoothing;
    }

    /**
     * Update which chunks are visible
     */
    updateVisibleChunks() {
        this.visibleChunks.clear();

        const viewDistance = 2; // chunks in each direction
        const centerChunkX = Math.floor(this.camera.x / this.worldGen.chunkSize);
        const centerChunkY = Math.floor(this.camera.y / this.worldGen.chunkSize);

        for (let dy = -viewDistance; dy <= viewDistance; dy++) {
            for (let dx = -viewDistance; dx <= viewDistance; dx++) {
                const chunkX = centerChunkX + dx;
                const chunkY = centerChunkY + dy;
                const chunkKey = `${chunkX},${chunkY}`;

                this.visibleChunks.add(chunkKey);

                // Generate chunk if not cached
                if (!this.chunks.has(chunkKey)) {
                    this.chunks.set(chunkKey, this.worldGen.generateChunk(chunkX, chunkY));
                }
            }
        }
    }

    /**
     * Render the game
     */
    render() {
        // Clear canvas
        this.ctx.fillStyle = '#0a0a0a';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        const tileSize = this.worldGen.tileSize * this.camera.zoom;
        const offsetX = this.canvas.width / 2 - this.camera.x * tileSize;
        const offsetY = this.canvas.height / 2 - this.camera.y * tileSize;

        // Render visible chunks
        for (const chunkKey of this.visibleChunks) {
            const chunk = this.chunks.get(chunkKey);
            if (!chunk) continue;

            this.renderChunk(chunk, offsetX, offsetY, tileSize);
        }

        // Render remote players
        for (const player of this.remotePlayers.values()) {
            this.renderPlayer(player, offsetX, offsetY, tileSize, '#2196F3');
        }

        // Render local player
        this.renderPlayer(this.player, offsetX, offsetY, tileSize, this.player.color);
    }

    /**
     * Render a chunk
     */
    renderChunk(chunk, offsetX, offsetY, tileSize) {
        for (let y = 0; y < this.worldGen.chunkSize; y++) {
            for (let x = 0; x < this.worldGen.chunkSize; x++) {
                const tile = chunk.tiles[y][x];
                const screenX = offsetX + tile.x * tileSize;
                const screenY = offsetY + tile.y * tileSize;

                // Skip if off screen
                if (screenX < -tileSize || screenX > this.canvas.width ||
                    screenY < -tileSize || screenY > this.canvas.height) {
                    continue;
                }

                // Draw tile
                this.ctx.fillStyle = tile.color;
                this.ctx.fillRect(screenX, screenY, tileSize, tileSize);

                // Add subtle border
                this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
                this.ctx.strokeRect(screenX, screenY, tileSize, tileSize);
            }
        }

        // Render entities
        for (const entity of chunk.entities) {
            const screenX = offsetX + entity.x * tileSize;
            const screenY = offsetY + entity.y * tileSize;

            if (screenX < -tileSize || screenX > this.canvas.width ||
                screenY < -tileSize || screenY > this.canvas.height) {
                continue;
            }

            this.renderEntity(entity, screenX, screenY, tileSize);
        }
    }

    /**
     * Render an entity (tree, rock, etc.)
     */
    renderEntity(entity, x, y, tileSize) {
        const size = tileSize * entity.size;
        const centerX = x + tileSize / 2;
        const centerY = y + tileSize / 2;

        this.ctx.fillStyle = entity.color;
        
        if (entity.type === 'tree') {
            // Draw tree
            this.ctx.beginPath();
            this.ctx.arc(centerX, centerY, size / 2, 0, Math.PI * 2);
            this.ctx.fill();
        } else if (entity.type === 'rock') {
            // Draw rock
            this.ctx.fillRect(centerX - size / 2, centerY - size / 2, size, size);
        } else {
            // Default circle
            this.ctx.beginPath();
            this.ctx.arc(centerX, centerY, size / 2, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }

    /**
     * Render a player
     */
    renderPlayer(player, offsetX, offsetY, tileSize, color) {
        const screenX = offsetX + player.x * tileSize;
        const screenY = offsetY + player.y * tileSize;

        // Draw player circle
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.arc(screenX, screenY, player.size * this.camera.zoom, 0, Math.PI * 2);
        this.ctx.fill();

        // Draw player outline
        this.ctx.strokeStyle = '#FFF';
        this.ctx.lineWidth = 2;
        this.ctx.stroke();

        // Draw direction indicator
        if (player.vx !== 0 || player.vy !== 0) {
            const angle = Math.atan2(player.vy, player.vx);
            const indicatorLength = player.size * this.camera.zoom * 1.5;
            
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = 3;
            this.ctx.beginPath();
            this.ctx.moveTo(screenX, screenY);
            this.ctx.lineTo(
                screenX + Math.cos(angle) * indicatorLength,
                screenY + Math.sin(angle) * indicatorLength
            );
            this.ctx.stroke();
        }
    }

    /**
     * Set UI update callback
     */
    setUICallback(element, callback) {
        this.uiCallbacks[element] = callback;
    }

    /**
     * Update UI element
     */
    updateUI(element, value) {
        if (this.uiCallbacks[element]) {
            this.uiCallbacks[element](value);
        }
    }

    /**
     * Stop the game
     */
    stop() {
        this.running = false;
    }

    /**
     * Cleanup
     */
    async cleanup() {
        this.stop();
        await this.network.disconnect();
    }
}
