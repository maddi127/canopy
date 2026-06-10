# Landscape Designer Application

An AI-powered landscaping design tool that generates custom landscape designs from aerial imagery and connects users with local nurseries and landscapers.

## Features

- 🗺️ **Aerial Property View**: Pull overhead imagery of any property
- 🎨 **AI Design Generation**: Create multiple landscaping designs based on user preferences
- 🌱 **Smart Plant Lists**: Generate shopping lists with local nursery inventory
- 👷 **Contractor Marketplace**: Connect with local landscapers for professional installation
- 📐 **Measurement Tools**: Automatic area calculations and material estimates

## Tech Stack

### Frontend
- React 18 with TypeScript
- Tailwind CSS for styling
- React Query for state management
- Mapbox GL JS for maps and aerial imagery
- Leaflet as alternative map solution

### Backend
- Node.js with Express
- TypeScript
- PostgreSQL database
- Prisma ORM
- JWT authentication

### Image Processing & AI
- Python 3.12
- OpenCV for image analysis
- PIL/Pillow for image manipulation
- Integration with AI image generation APIs

### Third-party Services
- Mapbox or Google Maps API (aerial imagery)
- OpenAI/Anthropic API (design generation)
- Stripe (payment processing)
- SendGrid (email notifications)

## Project Structure

```
landscape-designer/
├── frontend/                 # React application
│   ├── src/
│   │   ├── components/      # Reusable UI components
│   │   ├── pages/           # Route pages
│   │   ├── services/        # API calls
│   │   ├── hooks/           # Custom React hooks
│   │   ├── types/           # TypeScript types
│   │   └── utils/           # Helper functions
│   └── package.json
│
├── backend/                  # Node.js API server
│   ├── src/
│   │   ├── controllers/     # Request handlers
│   │   ├── models/          # Database models
│   │   ├── routes/          # API routes
│   │   ├── middleware/      # Auth, validation, etc.
│   │   ├── services/        # Business logic
│   │   └── utils/           # Helper functions
│   ├── prisma/              # Database schema
│   └── package.json
│
├── python-services/          # Image processing microservices
│   ├── image_processor/     # Aerial image analysis
│   ├── design_generator/    # AI design generation
│   └── requirements.txt
│
├── shared/                   # Shared types and utilities
│   └── types/
│
└── docs/                     # Documentation
    ├── api.md
    ├── architecture.md
    └── setup.md
```

## Prerequisites

- Node.js 18+ and npm
- Python 3.12+
- PostgreSQL 14+
- Git

## Quick Start

### 1. Clone and Install

```bash
# Install frontend dependencies
cd frontend
npm install

# Install backend dependencies
cd ../backend
npm install

# Install Python dependencies
cd ../python-services
pip install -r requirements.txt --break-system-packages
```

### 2. Environment Configuration

Create `.env` files in both frontend and backend directories:

**backend/.env:**
```env
DATABASE_URL="postgresql://user:password@localhost:5432/landscape_designer"
JWT_SECRET="your-secret-key"
MAPBOX_API_KEY="your-mapbox-key"
OPENAI_API_KEY="your-openai-key"
STRIPE_SECRET_KEY="your-stripe-key"
PORT=3001
```

**frontend/.env:**
```env
VITE_API_URL="http://localhost:3001"
VITE_MAPBOX_TOKEN="your-mapbox-token"
```

### 3. Database Setup

```bash
cd backend
npx prisma migrate dev
npx prisma generate
```

### 4. Run Development Servers

```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev

# Terminal 3 - Python services
cd python-services
python -m uvicorn main:app --reload --port 8000
```

## Development Workflow

### Frontend Development
- React development server runs on `http://localhost:5173`
- Hot reload enabled
- Component library: Consider Shadcn/ui or Material-UI

### Backend Development
- Express server runs on `http://localhost:3001`
- Auto-restart with nodemon
- API documentation at `/api/docs`

### Database Management
```bash
# Create migration
npx prisma migrate dev --name migration_name

# Reset database
npx prisma migrate reset

# Open Prisma Studio
npx prisma studio
```

## API Endpoints (Planned)

### Properties
- `POST /api/properties` - Add a new property
- `GET /api/properties/:id` - Get property details
- `GET /api/properties/:id/aerial` - Get aerial imagery

### Designs
- `POST /api/designs/generate` - Generate design variations
- `GET /api/designs/:id` - Get specific design
- `PUT /api/designs/:id` - Update design preferences
- `POST /api/designs/:id/plant-list` - Generate plant list

### Marketplace
- `GET /api/nurseries/nearby` - Find local nurseries
- `GET /api/nurseries/:id/inventory` - Check plant availability
- `POST /api/contractors/bid-request` - Request contractor bids
- `GET /api/contractors/nearby` - Find local landscapers

### User
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - User login
- `GET /api/user/projects` - User's projects

## Key Features to Implement

### Phase 1: MVP
- [x] Project setup
- [ ] Aerial imagery integration
- [ ] Basic property input interface
- [ ] Simple design parameter form
- [ ] Mock design generation
- [ ] Basic plant list output

### Phase 2: AI Integration
- [ ] Connect to AI image generation API
- [ ] Implement design variation generation
- [ ] Add style transfer capabilities
- [ ] Plant identification from designs
- [ ] Cost estimation algorithm

### Phase 3: Marketplace
- [ ] Nursery database integration
- [ ] Real-time inventory checking
- [ ] Contractor profile system
- [ ] Bidding/messaging system
- [ ] Payment integration

### Phase 4: Polish
- [ ] Mobile responsive design
- [ ] Save and share designs
- [ ] Before/after visualization
- [ ] Seasonal plant recommendations
- [ ] Maintenance schedule generator

## Testing

```bash
# Frontend tests
cd frontend
npm test

# Backend tests
cd backend
npm test

# Python tests
cd python-services
pytest
```

## Deployment

- **Frontend**: Vercel or Netlify
- **Backend**: Railway, Render, or AWS
- **Database**: Supabase or AWS RDS
- **Python Services**: Docker containers on AWS ECS or Railway

## Contributing

This is a personal project, but contributions and suggestions are welcome!

## License

MIT

## Next Steps

1. Set up PostgreSQL locally
2. Obtain API keys for mapping service (Mapbox recommended)
3. Create accounts for AI services (OpenAI or Anthropic)
4. Review and customize the database schema in `backend/prisma/schema.prisma`
5. Start with the frontend property input form
