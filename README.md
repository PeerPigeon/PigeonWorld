# PigeonWorld

A procedural open world multiplayer game built with **PeerPigeon** and **PigeonMatch**.

## Overview

PigeonWorld is a browser-based, peer-to-peer multiplayer open world game featuring:

- 🌍 **Procedural World Generation** - Infinite terrain with biomes (water, grass, forest, mountains, etc.)
- 🎮 **P2P Multiplayer** - Connect with other players through WebRTC mesh networking
- 🔗 **Decentralized** - No central game server required, powered by PeerPigeon
- 🎯 **Matchmaking** - Find and join other players using PigeonMatch
- ⚡ **Real-time Sync** - Player positions synchronized across the peer network

## Features

### World Generation
- Procedural terrain using fractal noise algorithms
- Multiple biomes: Water, Sand, Grass, Forest, Mountain, Snow
- Chunk-based rendering for optimal performance
- Randomly placed entities (trees, rocks, bushes)

### Multiplayer
- True peer-to-peer networking with PeerPigeon mesh
- Automatic peer discovery and connection management
- Player state synchronization
- Support for up to 100 players per world instance

### Gameplay
- Explore an infinite procedural world
- See other players in real-time
- Smooth camera following
- Collision detection with terrain

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- A modern web browser with WebRTC support

### Installation

1. Clone the repository:
```bash
git clone https://github.com/PeerPigeon/PigeonWorld.git
cd PigeonWorld
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm run dev
```

4. Open your browser to the URL shown (typically `http://localhost:5173`)

### Building for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Controls

- **W/A/S/D** or **Arrow Keys** - Move player
- **Space** - Jump/Interact (future feature)
- **E** - Gather resources (future feature)
- **Tab** - Show/Hide players (future feature)

## Architecture

### Components

1. **WorldGenerator** (`src/world/WorldGenerator.js`)
   - Generates procedural terrain using noise algorithms
   - Creates biomes and places entities
   - Manages chunk generation

2. **NetworkManager** (`src/network/NetworkManager.js`)
   - Handles PeerPigeon mesh network initialization
   - Manages PigeonMatch matchmaking
   - Synchronizes player state across peers

3. **GameEngine** (`src/game/GameEngine.js`)
   - Main game loop and rendering
   - Player movement and physics
   - Camera management
   - UI updates

### Technology Stack

- **PeerPigeon** - WebRTC-based P2P mesh networking
- **PigeonMatch** - Matchmaking and collaboration engine
- **Vite** - Build tool and dev server
- **HTML5 Canvas** - 2D rendering

## Network Architecture

PigeonWorld uses a decentralized architecture:

1. Players connect to a signaling server (`wss://pigeonhub.fly.dev`) for initial peer discovery
2. WebRTC connections are established directly between peers
3. PeerPigeon manages the mesh network topology
4. PigeonMatch handles matchmaking and session management
5. Player state is synchronized via gossip protocol

### Offline Mode

If network connection fails, the game continues in offline mode where you can still explore the procedural world.

## Development

### Project Structure

```
PigeonWorld/
├── src/
│   ├── game/
│   │   └── GameEngine.js       # Main game engine
│   ├── network/
│   │   └── NetworkManager.js   # P2P networking
│   ├── world/
│   │   └── WorldGenerator.js   # Procedural generation
│   └── index.js                # Application entry point
├── index.html                  # Main HTML file
├── package.json
└── README.md
```

### Adding Features

To add new features:

1. **New Game Mechanics** - Extend `GameEngine.js`
2. **World Features** - Modify `WorldGenerator.js`
3. **Network Events** - Add handlers in `NetworkManager.js`

### Testing Multiplayer

To test multiplayer locally:

1. Start the dev server
2. Open multiple browser windows/tabs
3. Each instance will connect as a separate peer
4. Players should see each other in the world

## Troubleshooting

### Network Connection Issues

- Check browser console for errors
- Ensure WebRTC is supported in your browser
- Try a different browser (Chrome/Firefox recommended)
- Check if firewall is blocking WebRTC connections

### Performance Issues

- Reduce view distance in `GameEngine.js`
- Clear chunk cache if memory usage is high
- Close unnecessary browser tabs

## Future Enhancements

- [ ] Inventory system
- [ ] Resource gathering
- [ ] Building mechanics
- [ ] Chat system
- [ ] Minimap
- [ ] Day/night cycle
- [ ] Mob AI
- [ ] Crafting system
- [ ] Persistent world state

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details

## Acknowledgments

- **PeerPigeon** - For providing the P2P mesh networking foundation
- **PigeonMatch** - For matchmaking capabilities
- **PigeonHub** - For signaling server infrastructure

## Links

- [PeerPigeon GitHub](https://github.com/PeerPigeon/PeerPigeon)
- [PigeonMatch npm](https://www.npmjs.com/package/pigeonmatch)
- [PigeonHub](https://github.com/draeder/pigeonhub)
