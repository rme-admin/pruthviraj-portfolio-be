const mysql = require('mysql2/promise');
require('dotenv').config(); // This loads variables from your .env file for local development

// This new configuration block is designed for both local and production environments.
const db = mysql.createPool({
    // For each setting, it tries to read a Vercel environment variable first.
    // If it doesn't find one, it falls back to your local XAMPP settings.
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'dbPortfolio',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = db;