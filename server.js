require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Import your route files
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();
const port = 8080;

// --- DYNAMIC CORS CONFIGURATION FOR MULTIPLE DOMAINS ---
// This new block reads your comma-separated list of allowed domains.
const whitelist = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];

const corsOptions = {
    origin: (origin, callback) => {
        // In development mode, we allow all origins for easy testing.
        if (process.env.NODE_ENV === 'development') {
            return callback(null, true);
        }
        
        // In production, we check if the incoming request origin is in our whitelist.
        // We also allow requests that have no origin (like Postman or mobile apps).
        if (!origin || whitelist.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            // If the origin is not in the whitelist, we reject the request.
            callback(new Error('This origin is not allowed by CORS'));
        }
    },
    optionsSuccessStatus: 200 // For legacy browser support
};


// --- MIDDLEWARE ---
app.use(cors(corsOptions)); // Use our new, more powerful CORS options
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));


// --- API ROUTES ---
app.use('/api/admin', adminRoutes);
app.use('/api', publicRoutes);


// --- START THE SERVER ---
const HOST = '0.0.0.0';

app.listen(port, HOST, () => {
    console.log(`Node.js server starting on http://${HOST}:${port}`);
    console.log(`Accessible locally at http://localhost:${port}`);
});