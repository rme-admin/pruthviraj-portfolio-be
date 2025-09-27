const express = require('express');
const router = express.Router();
const db = require('../database'); // Imports the database connection pool

// =================================================================
// MAIN ENDPOINT FOR INITIAL PAGE LOAD
// GET /api/portfolio-data
// =================================================================
router.get('/portfolio-data', async (req, res) => {
    try {
        // Define the keys we want to remove from the public response
        const forbiddenKeys = ['id', 'createdBy', 'updatedBy', 'updatedOn', 'createdOn'];

        // Helper function to filter unwanted keys from objects
        const filterKeys = (data, keysToRemove) => {
            if (!data) return null;
            if (Array.isArray(data)) {
                return data.map(item => filterKeys(item, keysToRemove));
            }
            const newItem = { ...data };
            for (const key of keysToRemove) {
                delete newItem[key];
            }
            return newItem;
        };

        

        // Define all the queries
        const siteDataQuery = 'SELECT * FROM site_data';
        //const userDetailsQuery = 'SELECT * FROM user_details ORDER BY id DESC LIMIT 1';
        const userDetailsQuery = `
            SELECT 
                u.email, ud.*
            FROM user_details ud
            LEFT JOIN users u ON ud.user_id = u.id
            ORDER BY ud.id DESC 
            LIMIT 1
        `;
        const socialLinksQuery = 'SELECT * FROM social_links';
        const skillsQuery = 'SELECT skill_name, category FROM skills ORDER BY category, skill_name';
        const educationQuery = 'SELECT * FROM education ORDER BY id DESC';
        const projectsQuery = 'SELECT * FROM projects ORDER BY date DESC';
        const experienceQuery = 'SELECT * FROM experience ORDER BY id DESC';
        const mediaQuery = 'SELECT * FROM media ORDER BY id DESC';
        const referencePersonQuery = 'SELECT * FROM reference_person ORDER BY id DESC';
        const publicationsQuery = 'SELECT * FROM publications ORDER BY id DESC';
        const achievementsQuery = 'SELECT * FROM achievements ORDER BY id DESC';
        const coursesQuery = 'SELECT * FROM courses_n_certificates ORDER BY id DESC';

        // Execute all queries in parallel for maximum efficiency
        const [
            siteDataResults, userDetailsResults, socialLinksResults, skillsResults,
            educationResults, projectsResults, experienceResults, mediaResults,
            referencePersonResults, publicationsResults, achievementsResults, coursesResults
        ] = await Promise.all([
            db.query(siteDataQuery), db.query(userDetailsQuery), db.query(socialLinksQuery),
            db.query(skillsQuery), db.query(educationQuery), db.query(projectsQuery),
            db.query(experienceQuery), db.query(mediaQuery), db.query(referencePersonQuery),
            db.query(publicationsQuery), db.query(achievementsQuery), db.query(coursesQuery)
        ]);
        
        // Process the Skills Data to be Grouped by Category
        const groupedSkills = skillsResults[0].reduce((acc, skill) => {
            const { category, skill_name } = skill;
            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push(skill_name);
            return acc;
        }, {});

        // Assemble the final JSON response object, applying our filter to each result
        const portfolioData = {
            site_data: filterKeys(siteDataResults[0][0] || null, forbiddenKeys),
            user_details: filterKeys(userDetailsResults[0][0] || null, forbiddenKeys),
            social_links: filterKeys(socialLinksResults[0], forbiddenKeys),
            skills: groupedSkills, // This one is already clean
            education: filterKeys(educationResults[0], forbiddenKeys),
            projects: filterKeys(projectsResults[0], forbiddenKeys),
            experience: filterKeys(experienceResults[0], forbiddenKeys),
            media: filterKeys(mediaResults[0], forbiddenKeys),
            reference_person: filterKeys(referencePersonResults[0], forbiddenKeys),
            publications: filterKeys(publicationsResults[0], forbiddenKeys),
            achievements: filterKeys(achievementsResults[0], forbiddenKeys),
            courses_n_certificates: filterKeys(coursesResults[0], forbiddenKeys)
        };

        res.json(portfolioData);

    } catch (err) {
        console.error('Database query error on /api/portfolio-data:', err);
        res.status(500).json({ error: 'Failed to retrieve portfolio data.' });
    }
});


// =================================================================
// ENDPOINT FOR FETCHING ALL PROJECTS
// GET /api/projects
// =================================================================
router.get('/projects', async (req, res) => {
    try {
        const sqlQuery = 'SELECT * FROM projects ORDER BY date DESC';
        const [projects] = await db.query(sqlQuery);

        const forbiddenKeys = ['id', 'createdBy', 'updatedBy', 'updatedOn', 'createdOn'];

        const filterKeys = (data, keysToRemove) => {
            if (!data) return null;
            return data.map(item => {
                const newItem = { ...item };
                for (const key of keysToRemove) {
                    delete newItem[key];
                }
                return newItem;
            });
        };

        const cleanedProjects = filterKeys(projects, forbiddenKeys);
        res.json(cleanedProjects);

    } catch (err) {
        console.error('Database query error on /api/projects:', err);
        res.status(500).json({ error: 'Failed to retrieve projects.' });
    }
});

// =================================================================
// PUBLIC ENDPOINT FOR SUBMITTING A NEW ENQUIRY
// =================================================================
router.post('/enquiries', async (req, res) => {
    try {
        const { name, email, reason, designation, date, message } = req.body;

        // Basic validation
        if (!name || !email || !message) {
            return res.status(400).json({ message: 'Name, email, and message are required fields.' });
        }

        const sql = `
            INSERT INTO enquiries 
            (name, email, reason, designation, message) 
            VALUES (?, ?, ?, ?, ?)
        `;
        
        // The date can be sent from the frontend or set to NOW()
        await db.query(sql, [name, email, reason, designation, message]);
        
        res.status(201).json({ message: 'Thank you for your enquiry. I will get back to you shortly.' });

    } catch (error) {
        console.error("Error submitting enquiry:", error);
        res.status(500).json({ message: 'Sorry, there was an error submitting your message. Please try again later.' });
    }
});


// This line makes all the routes defined in this file available to server.js
module.exports = router;