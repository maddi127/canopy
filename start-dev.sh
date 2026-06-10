#!/bin/bash

# Landscape Designer Development Startup Script

echo "🌿 Starting Landscape Designer Development Environment"
echo "=================================================="
echo ""

# Check if .env files exist
if [ ! -f backend/.env ]; then
    echo "⚠️  Warning: backend/.env not found"
    echo "   Copy backend/.env.example to backend/.env and configure it"
fi

if [ ! -f frontend/.env ]; then
    echo "⚠️  Warning: frontend/.env not found"
    echo "   Copy frontend/.env.example to frontend/.env and configure it"
fi

echo ""
echo "Choose what to start:"
echo "1) Frontend only (React)"
echo "2) Backend only (Express)"
echo "3) Python services only"
echo "4) Everything (opens 3 terminals)"
echo "5) Install all dependencies"
echo "6) Setup database"
echo ""
read -p "Enter your choice (1-6): " choice

case $choice in
    1)
        echo "Starting frontend..."
        cd frontend && npm run dev
        ;;
    2)
        echo "Starting backend..."
        cd backend && npm run dev
        ;;
    3)
        echo "Starting Python services..."
        cd python-services && python -m uvicorn main:app --reload --port 8000
        ;;
    4)
        echo "Starting all services..."
        echo "This will open 3 terminal tabs/windows"
        
        # For macOS
        if [[ "$OSTYPE" == "darwin"* ]]; then
            osascript -e 'tell application "Terminal" to do script "cd '$(pwd)'/backend && npm run dev"'
            osascript -e 'tell application "Terminal" to do script "cd '$(pwd)'/frontend && npm run dev"'
            osascript -e 'tell application "Terminal" to do script "cd '$(pwd)'/python-services && python -m uvicorn main:app --reload --port 8000"'
        else
            # For Linux/Windows WSL, use tmux or run sequentially
            echo "Opening in current terminal..."
            cd backend && npm run dev &
            cd ../frontend && npm run dev &
            cd ../python-services && python -m uvicorn main:app --reload --port 8000
        fi
        ;;
    5)
        echo "Installing dependencies..."
        echo "Frontend..."
        cd frontend && npm install
        echo "Backend..."
        cd ../backend && npm install
        echo "Python services..."
        cd ../python-services && pip install -r requirements.txt --break-system-packages
        echo "✅ All dependencies installed!"
        ;;
    6)
        echo "Setting up database..."
        cd backend
        npx prisma generate
        npx prisma migrate dev --name init
        echo "✅ Database setup complete!"
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac
