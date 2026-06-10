# 🌿 Landscape Designer - Quick Start Guide

Your development environment is ready! Here's how to get started.

## What's Been Set Up

✅ **Frontend**: React 18 + TypeScript + Tailwind CSS + Vite
✅ **Backend**: Node.js + Express + TypeScript + Prisma ORM
✅ **Python Services**: FastAPI for image processing and AI
✅ **Database Schema**: PostgreSQL with comprehensive models
✅ **Project Structure**: Organized, scalable architecture

## Immediate Next Steps

### 1. Install Dependencies (5 minutes)

```bash
cd landscape-designer

# Frontend
cd frontend
npm install

# Backend
cd ../backend
npm install

# Python services (optional for now)
cd ../python-services
pip install -r requirements.txt --break-system-packages
```

### 2. Configure Environment Variables (10 minutes)

**Backend (.env):**
```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` and set:
- `DATABASE_URL` - Your PostgreSQL connection string
- `JWT_SECRET` - Any random string for now
- Leave API keys empty for now (you can add them later)

**Frontend (.env):**
```bash
cd frontend
cp .env.example .env
```

The defaults should work for local development.

### 3. Setup Database (5 minutes)

First, make sure PostgreSQL is installed and running. Then:

```bash
cd backend
npx prisma generate
npx prisma migrate dev --name init
```

### 4. Start Development Servers

**Option A: Using the helper script**
```bash
./start-dev.sh
# Choose option 5 first to install dependencies
# Then choose option 1, 2, or 4 to run services
```

**Option B: Manual (3 separate terminals)**

Terminal 1 - Backend:
```bash
cd backend
npm run dev
# Runs on http://localhost:3001
```

Terminal 2 - Frontend:
```bash
cd frontend
npm run dev
# Runs on http://localhost:5173
```

Terminal 3 - Python (optional):
```bash
cd python-services
python -m uvicorn main:app --reload --port 8000
# Runs on http://localhost:8000
```

### 5. View the App

Open your browser to: **http://localhost:5173**

You should see the landing page!

## What to Build First

### Phase 1: Property Input (Week 1)
1. Create property input form component
2. Integrate Mapbox for address autocomplete
3. Display aerial imagery of the property
4. Save property data to database

**Files to create:**
- `frontend/src/components/PropertyForm.tsx`
- `backend/src/routes/properties.ts`
- `backend/src/controllers/propertyController.ts`

### Phase 2: Design Generation (Week 2-3)
1. Create design preferences form
2. Integrate AI image generation (OpenAI DALL-E or similar)
3. Display generated designs in a gallery
4. Allow users to save favorites

**Key integrations needed:**
- OpenAI API or Anthropic Claude for image generation
- Image storage (S3, Cloudinary, or local)

### Phase 3: Plant Lists (Week 4)
1. Seed database with plant data
2. Create plant recommendation algorithm
3. Generate shopping lists from designs
4. Connect with nursery APIs (if available)

### Phase 4: Marketplace (Week 5-6)
1. Create contractor/nursery listings
2. Build bidding system
3. Add messaging between users and contractors
4. Integrate payment processing (Stripe)

## Key API Integrations You'll Need

### Essential:
- **Mapbox or Google Maps** - For aerial imagery and geocoding
  - Free tier: 50,000 requests/month (Mapbox)
  - Sign up: https://account.mapbox.com/

### For AI Generation:
- **OpenAI DALL-E** - For design image generation
  - Pricing: ~$0.02-0.12 per image
  - Sign up: https://platform.openai.com/

OR

- **Anthropic Claude** - For design suggestions and plant recommendations
  - More cost-effective for text, can guide design
  - Sign up: https://console.anthropic.com/

### Optional:
- **Stripe** - For payment processing (later phase)
- **SendGrid** - For email notifications (later phase)

## Project Structure Overview

```
landscape-designer/
├── frontend/           # React UI
│   ├── src/
│   │   ├── pages/     # Route components (Home, Property, Design, Marketplace)
│   │   ├── components/# Reusable UI components (to be created)
│   │   └── services/  # API calls (to be created)
│   └── package.json
│
├── backend/            # Express API
│   ├── src/
│   │   ├── index.ts   # Server entry point (✅ created)
│   │   ├── routes/    # API routes (to be created)
│   │   ├── controllers/# Request handlers (to be created)
│   │   └── middleware/# Auth, validation (to be created)
│   └── prisma/
│       └── schema.prisma  # Database models (✅ created)
│
└── python-services/    # Image processing
    ├── main.py        # FastAPI app (✅ created)
    └── requirements.txt
```

## Helpful Resources

- **Full Documentation**: See `docs/setup.md` for detailed setup
- **Database GUI**: Run `npx prisma studio` from backend folder
- **API Testing**: Use Postman or curl to test backend endpoints
- **React DevTools**: Install browser extension for debugging

## Common First-Time Issues

**"Port already in use"**
```bash
# Find what's using the port
lsof -i :3001
# Kill the process
kill -9 <PID>
```

**"Cannot connect to database"**
- Make sure PostgreSQL is running
- Check your DATABASE_URL in .env
- Try: `psql postgres` to verify PostgreSQL works

**"Module not found"**
- Make sure you ran `npm install` in both frontend and backend
- Try deleting node_modules and running `npm install` again

## Need Help?

- Backend API docs: Once running, check http://localhost:3001/api
- Python API docs: Once running, check http://localhost:8000/docs
- Check the README.md for full feature list and architecture

## Your Next Commands

```bash
cd landscape-designer

# Install everything
./start-dev.sh
# Choose option 5

# Then start development
./start-dev.sh
# Choose option 4 (or 1/2 individually)
```

Good luck with your project! 🚀🌱
