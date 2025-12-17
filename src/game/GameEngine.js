import * as THREE from 'three';
import { WorldGenerator } from '../world/WorldGenerator.js';
import { NetworkManager } from '../network/NetworkManager.js';

/**
 * Main game engine - 3D Version
 * Handles rendering, player movement, and game loop using Three.js
 */
export class GameEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.worldGen = new WorldGenerator();
        this.network = new NetworkManager();
        
        // Three.js setup
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.playerMesh = null;
        this.remoteMeshes = new Map();
        
        // Camera settings for first-person view
        this.cameraOffset = new THREE.Vector3(0, 1.6, 0); // Eye level height
        this.cameraLookAtDistance = 5; // Look ahead distance (reduced for better ground visibility)

        // Local player
        this.player = {
            x: 0,
            y: 10,
            z: 0,
            vx: 0,
            vy: 0,
            vz: 0,
            speed: 0.2,
            rotation: 0,
            size: 2,
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
        console.log('Initializing 3D game engine...');

        // Initialize Three.js
        this.initThreeJS();

        // Set up input handlers
        this.setupInputHandlers();

        // Generate initial world
        this.generateWorld();

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

        this.initialized = true;
        console.log('3D game engine initialized');
    }

    /**
     * Initialize Three.js scene, camera, and renderer
     */
    initThreeJS() {
        // Create scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB); // Sky blue
        this.scene.fog = new THREE.Fog(0x87CEEB, 50, 200);

        // Create camera
        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        this.camera.position.set(0, 30, 40);
        this.camera.lookAt(0, 0, 0);

        // Create renderer
        this.renderer = new THREE.WebGLRenderer({ 
            canvas: this.canvas,
            antialias: true 
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        // Add lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(50, 100, 50);
        directionalLight.castShadow = true;
        directionalLight.shadow.camera.left = -100;
        directionalLight.shadow.camera.right = 100;
        directionalLight.shadow.camera.top = 100;
        directionalLight.shadow.camera.bottom = -100;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        this.scene.add(directionalLight);

        // Create player mesh
        const playerGeometry = new THREE.CapsuleGeometry(this.player.size / 2, this.player.size, 8, 16);
        const playerMaterial = new THREE.MeshStandardMaterial({ 
            color: this.player.color,
            metalness: 0.3,
            roughness: 0.7
        });
        this.playerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
        this.playerMesh.castShadow = true;
        this.playerMesh.receiveShadow = true;
        this.playerMesh.position.set(this.player.x, this.player.y, this.player.z);
        // Hide player mesh in first-person view
        this.playerMesh.visible = false;
        this.scene.add(this.playerMesh);

        // Handle window resize
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    /**
     * Generate the 3D world
     */
    generateWorld() {
        const viewDistance = 2; // Reduced for performance
        const chunkSize = this.worldGen.chunkSize;



        for (let chunkZ = -viewDistance; chunkZ <= viewDistance; chunkZ++) {
            for (let chunkX = -viewDistance; chunkX <= viewDistance; chunkX++) {
                const chunkKey = `${chunkX},${chunkZ}`;
                const chunk = this.worldGen.generateChunk(chunkX, chunkZ);
                this.chunks.set(chunkKey, chunk);
                this.addChunkToScene(chunk);
            }
        }
        

    }

    /**
     * Add a chunk's terrain to the Three.js scene
     */
    addChunkToScene(chunk) {
        const chunkSize = this.worldGen.chunkSize;
        const tileSize = 1; // Use 1 unit per tile for better scale in 3D

        // Create geometry for the terrain
        const geometry = new THREE.BufferGeometry();
        const vertices = [];
        const colors = [];
        const indices = [];

        for (let z = 0; z < chunkSize; z++) {
            for (let x = 0; x < chunkSize; x++) {
                const tile = chunk.tiles[z][x];
                const worldX = (chunk.x * chunkSize + x) * tileSize;
                const worldZ = (chunk.z * chunkSize + z) * tileSize;
                const height = tile.height * 10; // Scale height to 0-10 range

                // Get color from biome
                const color = new THREE.Color(tile.color);

                // Create quad vertices (two triangles per tile)
                const x0 = worldX;
                const x1 = worldX + tileSize;
                const z0 = worldZ;
                const z1 = worldZ + tileSize;

                const idx = vertices.length / 3;

                // Four corners
                vertices.push(x0, height, z0);
                vertices.push(x1, height, z0);
                vertices.push(x1, height, z1);
                vertices.push(x0, height, z1);

                // Colors for each vertex
                for (let i = 0; i < 4; i++) {
                    colors.push(color.r, color.g, color.b);
                }

                // Two triangles
                indices.push(idx, idx + 1, idx + 2);
                indices.push(idx, idx + 2, idx + 3);
            }
        }

        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            flatShading: true,
            metalness: 0.2,
            roughness: 0.8
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.receiveShadow = true;
        mesh.userData.chunkKey = `${chunk.x},${chunk.z}`;
        this.scene.add(mesh);

        // Add entities (trees, rocks, etc.)
        this.addEntitiesToScene(chunk);
    }

    /**
     * Add entities like trees and rocks to the scene
     */
    addEntitiesToScene(chunk) {
        const tileSize = 1; // Match terrain scale
        const chunkSize = this.worldGen.chunkSize;

        for (const entity of chunk.entities) {
            const worldX = entity.x * tileSize;
            const worldZ = entity.y * tileSize;
            
            // Get height at this position
            const localX = entity.x - chunk.x * chunkSize;
            const localZ = entity.y - chunk.z * chunkSize;
            const tile = chunk.tiles[localZ][localX];
            const height = tile.height * 10; // Match terrain height scale

            let geometry, material;

            // Simplified rendering - only add 20% of entities for performance
            if (Math.random() > 0.8) {
                if (entity.type === 'tree') {
                    // Simpler tree representation
                    const treeGeom = new THREE.ConeGeometry(2, 5, 6);
                    const treeMat = new THREE.MeshStandardMaterial({ color: entity.color });
                    const tree = new THREE.Mesh(treeGeom, treeMat);
                    tree.position.set(worldX, height + 2.5, worldZ);
                    tree.castShadow = true;
                    this.scene.add(tree);

                } else if (entity.type === 'rock') {
                    geometry = new THREE.BoxGeometry(entity.size * 2, entity.size * 2, entity.size * 2);
                    material = new THREE.MeshStandardMaterial({ 
                        color: entity.color,
                        metalness: 0.5,
                        roughness: 0.9
                    });
                    const mesh = new THREE.Mesh(geometry, material);
                    mesh.position.set(worldX, height + entity.size, worldZ);
                    mesh.castShadow = true;
                    this.scene.add(mesh);
                }
            }
        }
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

        // Update remote players
        this.updateRemotePlayers();

        // Send player update to network (throttled to ~20 updates per second)
        const timeSinceLastNetworkUpdate = now - this.lastNetworkUpdate;
        if (timeSinceLastNetworkUpdate > 50) {
            this.network.sendPlayerUpdate(this.player);
            this.lastNetworkUpdate = now;
        }

        // Update UI
        this.updateUI('position', `${Math.floor(this.player.x)}, ${Math.floor(this.player.z)}`);
        const chunkX = Math.floor(this.player.x / (this.worldGen.chunkSize * this.worldGen.tileSize));
        const chunkZ = Math.floor(this.player.z / (this.worldGen.chunkSize * this.worldGen.tileSize));
        this.updateUI('chunk', `${chunkX}, ${chunkZ}`);
    }

    /**
     * Update player position based on input - 3D version
     */
    updatePlayer(deltaTime) {
        const speed = this.player.speed * deltaTime;

        // Reset velocity
        this.player.vx = 0;
        this.player.vz = 0;

        // WASD movement in 3D space
        if (this.keys['w'] || this.keys['arrowup']) this.player.vz -= speed;
        if (this.keys['s'] || this.keys['arrowdown']) this.player.vz += speed;
        if (this.keys['a'] || this.keys['arrowleft']) this.player.vx -= speed;
        if (this.keys['d'] || this.keys['arrowright']) this.player.vx += speed;

        // Normalize diagonal movement
        if (this.player.vx !== 0 && this.player.vz !== 0) {
            const magnitude = Math.sqrt(this.player.vx * this.player.vx + this.player.vz * this.player.vz);
            this.player.vx = (this.player.vx / magnitude) * speed;
            this.player.vz = (this.player.vz / magnitude) * speed;
        }

        // Update position
        const newX = this.player.x + this.player.vx;
        const newZ = this.player.z + this.player.vz;

        // Check if new position is walkable and update height
        const tile = this.worldGen.getTileAt(
            Math.floor(newX), 
            Math.floor(newZ)
        );
        
        if (tile && tile.walkable) {
            this.player.x = newX;
            this.player.z = newZ;
            // Set player height based on terrain (match terrain scale)
            this.player.y = tile.height * 10 + this.player.size;
        }

        // Update player mesh position
        if (this.playerMesh) {
            this.playerMesh.position.set(this.player.x, this.player.y, this.player.z);
            
            // Rotate player mesh based on movement direction
            if (this.player.vx !== 0 || this.player.vz !== 0) {
                this.player.rotation = Math.atan2(this.player.vx, this.player.vz);
                this.playerMesh.rotation.y = this.player.rotation;
            }
        }
    }

    /**
     * Update camera to follow player - First-person view
     */
    updateCamera() {
        const smoothing = 0.2;
        
        // Position camera at player's eye level
        const targetX = this.player.x + this.cameraOffset.x;
        const targetY = this.player.y + this.cameraOffset.y;
        const targetZ = this.player.z + this.cameraOffset.z;
        
        // Smooth camera movement
        this.camera.position.x += (targetX - this.camera.position.x) * smoothing;
        this.camera.position.y += (targetY - this.camera.position.y) * smoothing;
        this.camera.position.z += (targetZ - this.camera.position.z) * smoothing;
        
        // Calculate look direction based on player rotation
        // If player is moving, use movement direction; otherwise maintain current direction
        if (this.player.vx !== 0 || this.player.vz !== 0) {
            this.player.rotation = Math.atan2(this.player.vx, this.player.vz);
        }
        
        // Look ahead with slight downward tilt to see immediate ground
        // Camera at player.y + 1.6, lookAt slightly below to show ground in lower screen
        const lookAtPoint = new THREE.Vector3(
            this.player.x + Math.sin(this.player.rotation) * this.cameraLookAtDistance,
            this.player.y - 1, // Slight downward tilt to see ground immediately ahead
            this.player.z + Math.cos(this.player.rotation) * this.cameraLookAtDistance
        );
        this.camera.lookAt(lookAtPoint);
    }

    /**
     * Update remote player meshes
     */
    updateRemotePlayers() {
        // Update existing remote player meshes
        for (const [peerId, player] of this.remotePlayers.entries()) {
            if (!this.remoteMeshes.has(peerId)) {
                // Create new mesh for remote player
                const geometry = new THREE.CapsuleGeometry(1, 2, 8, 16);
                const material = new THREE.MeshStandardMaterial({ 
                    color: '#2196F3',
                    metalness: 0.3,
                    roughness: 0.7
                });
                const mesh = new THREE.Mesh(geometry, material);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                this.scene.add(mesh);
                this.remoteMeshes.set(peerId, mesh);
            }
            
            const mesh = this.remoteMeshes.get(peerId);
            mesh.position.set(player.x || 0, player.y || 5, player.z || 0);
        }
        
        // Remove meshes for disconnected players
        for (const [peerId, mesh] of this.remoteMeshes.entries()) {
            if (!this.remotePlayers.has(peerId)) {
                this.scene.remove(mesh);
                this.remoteMeshes.delete(peerId);
            }
        }
    }

    /**
     * Render the game using Three.js
     */
    render() {
        this.renderer.render(this.scene, this.camera);
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
