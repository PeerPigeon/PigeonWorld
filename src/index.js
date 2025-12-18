import { GameEngine } from './game/GameEngine.js';

/**
 * Main application entry point
 */
class PigeonWorld {
    constructor() {
        this.game = null;
        this.loading = document.getElementById('loading');
        this.uiOverlay = document.getElementById('ui-overlay');
    }

    /**
     * Initialize and start the game
     */
    async init() {
        console.log('Starting PigeonWorld...');

        try {
            // Get canvas element
            const canvas = document.getElementById('game-canvas');
            if (!canvas) {
                throw new Error('Canvas element not found');
            }

            // Create game engine
            this.game = new GameEngine(canvas);

            // Set up UI callbacks
            this.setupUICallbacks();

            // Initialize game (includes network connection)
            await this.game.init();

            // Hide loading screen
            this.loading.style.display = 'none';
            this.uiOverlay.style.display = 'block';

            // Start game loop
            this.game.start();

            console.log('PigeonWorld started successfully!');
        } catch (error) {
            console.error('Failed to start PigeonWorld:', error);
            this.showError(error);
        }
    }

    /**
     * Set up UI update callbacks
     */
    setupUICallbacks() {
        this.game.setUICallback('status', (value) => {
            const statusEl = document.getElementById('network-status');
            if (statusEl) {
                statusEl.textContent = value;
                statusEl.style.color = value === 'Connected' ? '#4CAF50' : '#FF9800';
            }
        });

        this.game.setUICallback('peers', (value) => {
            const peersEl = document.getElementById('peer-count');
            if (peersEl) {
                peersEl.textContent = value;
            }
        });

        this.game.setUICallback('position', (value) => {
            const posEl = document.getElementById('position');
            if (posEl) {
                posEl.textContent = value;
            }
        });

        this.game.setUICallback('chunk', (value) => {
            const chunkEl = document.getElementById('chunk');
            if (chunkEl) {
                chunkEl.textContent = value;
            }
        });

        this.game.setUICallback('players', (value) => {
            const playersEl = document.getElementById('players-nearby');
            if (playersEl) {
                playersEl.textContent = value;
            }
        });

        this.game.setUICallback('resources', (value) => {
            const el = document.getElementById('resources');
            if (el) {
                el.textContent = value;
            }
        });
    }

    /**
     * Show error message
     */
    showError(error) {
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.innerHTML = `
                <h2 style="color: #f44336;">Error Starting Game</h2>
                <p style="color: #ff9800; margin-top: 20px;">${error.message}</p>
                <p style="margin-top: 10px; font-size: 14px; color: #888;">
                    Check the console for more details.
                </p>
                <button onclick="location.reload()" 
                    style="margin-top: 20px; padding: 10px 20px; background: #4CAF50; 
                    border: none; color: white; border-radius: 4px; cursor: pointer;">
                    Retry
                </button>
            `;
        }
    }
}

// Start the game when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        const app = new PigeonWorld();
        app.init();
    });
} else {
    const app = new PigeonWorld();
    app.init();
}

// Handle cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (window.pigeonWorld && window.pigeonWorld.game) {
        window.pigeonWorld.game.cleanup();
    }
});
