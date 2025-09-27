const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const db = require('../database');
const fs = require('fs/promises');


const router = express.Router();

// --- MULTER CONFIGURATION FOR ALL FILE UPLOADS ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Route files to different folders based on their MIME type
        if (file.mimetype.startsWith('image/')) {
            cb(null, 'public/uploads/images');
        } else {
            // For PDFs (cv, cover_letter) and other files
            cb(null, 'public/uploads/files');
        }
    },
    filename: (req, file, cb) => {
        // Prepend a timestamp to the original filename to ensure uniqueness
        const uniquePrefix = Date.now();
        cb(null, uniquePrefix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });


// --- AUTHENTICATION ---
// POST /api/admin/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const user = rows[0];
        const isPasswordMatch = await bcrypt.compare(password, user.password);
        if (!isPasswordMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({ message: 'Login successful', token });

    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: 'Server error during login' });
    }
});


// --- JWT AUTHENTICATION MIDDLEWARE ---
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer TOKEN

    if (!token) {
        return res.status(403).json({ message: 'A token is required for authentication' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
    } catch (err) {
        return res.status(401).json({ message: 'Invalid Token' });
    }
    return next();
};


// =================================================================
// APIs FOR "MY INFO" PAGE
// =================================================================

// GET /api/admin/my-info - Fetches all data for the My Info page.
router.get('/my-info', verifyToken, async (req, res) => {
    try {
        const sql = `
            SELECT 
                u.email, ud.prefix, ud.first_name, ud.last_name,
                ud.profile_url, ud.cv_url, ud.cover_letter_url,
                ud.about_me, ud.phone_number, ud.address
            FROM users u
            LEFT JOIN user_details ud ON u.id = ud.user_id
            WHERE u.id = ?
        `;
        const [rows] = await db.query(sql, [req.user.id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'User details not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching my-info:", error);
        res.status(500).json({ message: 'Server error' });
    }
});

// PUT /api/admin/my-info - Updates all data and handles file uploads.
router.put(
    '/my-info', 
    verifyToken, 
    upload.fields([
        { name: 'profile_image', maxCount: 1 },
        { name: 'cv', maxCount: 1 },
        { name: 'cover_letter', maxCount: 1 }
    ]), 
    async (req, res) => {
        try {
            const { prefix, first_name, last_name, about_me, email, phone_number, address } = req.body;
            const files = req.files;

            const [currentUserDetails] = await db.query('SELECT profile_url, cv_url, cover_letter_url FROM user_details WHERE user_id = ?', [req.user.id]);
            const currentUrls = currentUserDetails[0];

            const profile_url = files.profile_image ? files.profile_image[0].path.replace('public/', '') : currentUrls.profile_url;
            const cv_url = files.cv ? files.cv[0].path.replace('public/', '') : currentUrls.cv_url;
            const cover_letter_url = files.cover_letter ? files.cover_letter[0].path.replace('public/', '') : currentUrls.cover_letter_url;

            await db.query('UPDATE users SET email = ?, updatedBy = ? WHERE id = ?', [email, req.user.email, req.user.id]);

            const userDetailsSql = `
                UPDATE user_details 
                SET prefix=?, first_name=?, last_name=?, about_me=?, phone_number=?, address=?, 
                    profile_url=?, cv_url=?, cover_letter_url=?, updatedBy=?
                WHERE user_id=?
            `;
            await db.query(userDetailsSql, [
                prefix, first_name, last_name, about_me, phone_number, address,
                profile_url, cv_url, cover_letter_url, req.user.email, req.user.id
            ]);

            res.json({ message: 'Your information has been updated successfully.' });
        } catch (error) {
            console.error("Error updating my-info:", error);
            res.status(500).json({ message: 'Server error while updating information.' });
        }
    }
);


// =================================================================
// APIs FOR "PROJECTS" PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/projects - Get ALL projects for the data table view.
router.get('/projects', verifyToken, async (req, res) => {
    try {
        const [projects] = await db.query('SELECT id, title, category, date, live_link FROM projects ORDER BY date DESC');
        res.json(projects);
    } catch (error) {
        console.error("Error fetching projects:", error);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/admin/projects/:id - Get a SINGLE project for the "Edit" form.
router.get('/projects/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM projects WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Project not found' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single project:", error);
        res.status(500).json({ message: 'Server error' });
    }
});

// POST /api/admin/projects - Add a NEW project.
router.post('/projects', verifyToken, upload.single('image'), async (req, res) => {
    try {
        const { title, description, location, date, live_link, category } = req.body;
        // Get the relative path of the uploaded file from multer
        const img_url = req.file ? req.file.path.replace('public/', '') : null;

        const sql = 'INSERT INTO projects (title, description, location, date, live_link, category, img_url, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
        await db.query(sql, [title, description, location, date, live_link, category, img_url, req.user.email]);
        
        res.status(201).json({ message: 'Project created successfully' });
    } catch (error) {
        console.error("Error creating project:", error);
        res.status(500).json({ message: 'Server error' });
    }
});

// PUT /api/admin/projects/:id - UPDATE an existing project.
router.put('/projects/:id', verifyToken, upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, location, date, live_link, category, existingImageUrl } = req.body;
        let img_url = existingImageUrl; // Default to the existing image URL

        // If a new file is uploaded, update the img_url and delete the old one
        if (req.file) {
            img_url = req.file.path.replace('public/', '');

            // Best practice: Delete the old image if it exists to save space
            if (existingImageUrl) {
                const oldImagePath = path.join(__dirname, '..', 'public', existingImageUrl);
                try {
                    await fs.unlink(oldImagePath);
                } catch (err) {
                    console.error("Could not delete old project image:", err.message);
                }
            }
        }

        const sql = 'UPDATE projects SET title=?, description=?, location=?, date=?, live_link=?, category=?, img_url=?, updatedBy=? WHERE id=?';
        await db.query(sql, [title, description, location, date, live_link, category, img_url, req.user.email, id]);
        
        res.json({ message: 'Project updated successfully' });
    } catch (error) {
        console.error("Error updating project:", error);
        res.status(500).json({ message: 'Server error' });
    }
});

// DELETE /api/admin/projects/:id - DELETE a project.
router.delete('/projects/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        // First, get the image URL from the database to delete the file
        const [rows] = await db.query('SELECT img_url FROM projects WHERE id = ?', [id]);
        if (rows.length > 0 && rows[0].img_url) {
            const imagePath = path.join(__dirname, '..', 'public', rows[0].img_url);
            try {
                // Delete the file from the file system
                await fs.unlink(imagePath);
            } catch (err) {
                // Log if file doesn't exist, but don't stop the process
                console.error("Could not delete project image:", err.message);
            }
        }

        // Then, delete the record from the database
        await db.query('DELETE FROM projects WHERE id = ?', [id]);
        
        res.json({ message: 'Project deleted successfully' });
    } catch (error) {
        console.error("Error deleting project:", error);
        res.status(500).json({ message: 'Server error' });
    }
});

// =================================================================
// APIs FOR "EDUCATION" PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/education - a. Get all education entries
router.get('/education', verifyToken, async (req, res) => {
    try {
        // Order by ID descending to show the most recently added items first
        const [educationList] = await db.query('SELECT * FROM education ORDER BY id DESC');
        res.json(educationList);
    } catch (error) {
        console.error("Error fetching education list:", error);
        res.status(500).json({ message: 'Server error while fetching education data.' });
    }
});

// GET /api/admin/education/:id - b. Get a single education entry for editing
router.get('/education/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM education WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Education entry not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single education entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// POST /api/admin/education - c. Create a new education entry
router.post('/education', verifyToken, async (req, res) => {
    try {
        const { course, institute, period, description, mark_obtained, max_mark, entry_type } = req.body;
        const createdBy = req.user.email; // Get user email from the verified token

        const sql = `
            INSERT INTO education 
            (course, institute, period, description, mark_obtained, max_mark, entry_type, createdBy) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        await db.query(sql, [course, institute, period, description, mark_obtained, max_mark, entry_type, createdBy]);
        
        res.status(201).json({ message: 'Education entry created successfully.' });
    } catch (error) {
        console.error("Error creating education entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/education/:id - d. Update an existing education entry
router.put('/education/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { course, institute, period, description, mark_obtained, max_mark, entry_type } = req.body;
        const updatedBy = req.user.email;

        const sql = `
            UPDATE education 
            SET course=?, institute=?, period=?, description=?, mark_obtained=?, max_mark=?, entry_type=?, updatedBy=? 
            WHERE id=?
        `;
        
        const [result] = await db.query(sql, [course, institute, period, description, mark_obtained, max_mark, entry_type, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Education entry not found or no changes made.' });
        }
        
        res.json({ message: 'Education entry updated successfully.' });
    } catch (error) {
        console.error("Error updating education entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/education/:id - e. Delete an education entry
router.delete('/education/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query('DELETE FROM education WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Education entry not found.' });
        }

        res.json({ message: 'Education entry deleted successfully.' });
    } catch (error) {
        console.error("Error deleting education entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});



// =================================================================
// APIs FOR "EXPERIENCE" PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/experience - Get all experience entries
router.get('/experience', verifyToken, async (req, res) => {
    try {
        // Order by ID descending to show the most recent jobs first
        const [experienceList] = await db.query('SELECT * FROM experience ORDER BY id DESC');
        res.json(experienceList);
    } catch (error) {
        console.error("Error fetching experience list:", error);
        res.status(500).json({ message: 'Server error while fetching experience data.' });
    }
});

// GET /api/admin/experience/:id - Get a single experience entry for editing
router.get('/experience/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM experience WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Experience entry not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single experience entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// POST /api/admin/experience - Create a new experience entry
router.post('/experience', verifyToken, async (req, res) => {
    try {
        const { role, company, period, description } = req.body;
        const createdBy = req.user.email; // Get user from the verified token

        const sql = `
            INSERT INTO experience 
            (role, company, period, description, createdBy) 
            VALUES (?, ?, ?, ?, ?)
        `;
        
        await db.query(sql, [role, company, period, description, createdBy]);
        
        res.status(201).json({ message: 'Experience entry created successfully.' });
    } catch (error) {
        console.error("Error creating experience entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/experience/:id - Update an existing experience entry
router.put('/experience/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { role, company, period, description } = req.body;
        const updatedBy = req.user.email;

        const sql = `
            UPDATE experience 
            SET role=?, company=?, period=?, description=?, updatedBy=? 
            WHERE id=?
        `;
        
        const [result] = await db.query(sql, [role, company, period, description, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Experience entry not found or no changes made.' });
        }
        
        res.json({ message: 'Experience entry updated successfully.' });
    } catch (error) {
        console.error("Error updating experience entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/experience/:id - Delete an experience entry
router.delete('/experience/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query('DELETE FROM experience WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Experience entry not found.' });
        }

        res.json({ message: 'Experience entry deleted successfully.' });
    } catch (error) {
        console.error("Error deleting experience entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// =================================================================
// APIs FOR "PUBLICATIONS" PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/publications - Get all publication entries
router.get('/publications', verifyToken, async (req, res) => {
    try {
        // Order by ID descending to show the most recent publications first
        const [publicationList] = await db.query('SELECT * FROM publications ORDER BY id DESC');
        res.json(publicationList);
    } catch (error) {
        console.error("Error fetching publication list:", error);
        res.status(500).json({ message: 'Server error while fetching publication data.' });
    }
});

// GET /api/admin/publications/:id - Get a single publication entry for editing
router.get('/publications/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM publications WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Publication entry not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single publication entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// POST /api/admin/publications - Create a new publication entry
router.post('/publications', verifyToken, async (req, res) => {
    try {
        const { title, author, venue, doi, summary } = req.body;
        const createdBy = req.user.email; // Get user from the verified token

        const sql = `
            INSERT INTO publications 
            (title, author, venue, doi, summary, createdBy) 
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        
        await db.query(sql, [title, author, venue, doi, summary, createdBy]);
        
        res.status(201).json({ message: 'Publication entry created successfully.' });
    } catch (error) {
        console.error("Error creating publication entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/publications/:id - Update an existing publication entry
router.put('/publications/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, author, venue, doi, summary } = req.body;
        const updatedBy = req.user.email;

        const sql = `
            UPDATE publications 
            SET title=?, author=?, venue=?, doi=?, summary=?, updatedBy=? 
            WHERE id=?
        `;
        
        const [result] = await db.query(sql, [title, author, venue, doi, summary, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Publication entry not found or no changes made.' });
        }
        
        res.json({ message: 'Publication entry updated successfully.' });
    } catch (error) {
        console.error("Error updating publication entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/publications/:id - Delete a publication entry
router.delete('/publications/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query('DELETE FROM publications WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Publication entry not found.' });
        }

        res.json({ message: 'Publication entry deleted successfully.' });
    } catch (error) {
        console.error("Error deleting publication entry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});
// =================================================================

// =================================================================
// APIs FOR "ACHIEVEMENTS" PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/achievements - Get all achievement entries
router.get('/achievements', verifyToken, async (req, res) => {
    try {
        // Order by ID descending to show the newest achievements first
        const [achievementList] = await db.query('SELECT * FROM achievements ORDER BY id DESC');
        res.json(achievementList);
    } catch (error) {
        console.error("Error fetching achievement list:", error);
        res.status(500).json({ message: 'Server error while fetching achievements.' });
    }
});

// GET /api/admin/achievements/:id - Get a single achievement for editing
router.get('/achievements/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM achievements WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Achievement not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single achievement:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// POST /api/admin/achievements - Create a new achievement
router.post('/achievements', verifyToken, async (req, res) => {
    try {
        const { achievement } = req.body;
        const createdBy = req.user.email;

        if (!achievement || achievement.trim() === '') {
            return res.status(400).json({ message: 'Achievement text cannot be empty.' });
        }

        const sql = `INSERT INTO achievements (achievement, createdBy) VALUES (?, ?)`;
        await db.query(sql, [achievement, createdBy]);
        
        res.status(201).json({ message: 'Achievement created successfully.' });
    } catch (error) {
        console.error("Error creating achievement:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/achievements/:id - Update an existing achievement
router.put('/achievements/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { achievement } = req.body;
        const updatedBy = req.user.email;

        if (!achievement || achievement.trim() === '') {
            return res.status(400).json({ message: 'Achievement text cannot be empty.' });
        }

        const sql = `UPDATE achievements SET achievement=?, updatedBy=? WHERE id=?`;
        const [result] = await db.query(sql, [achievement, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Achievement not found or no changes made.' });
        }
        
        res.json({ message: 'Achievement updated successfully.' });
    } catch (error) {
        console.error("Error updating achievement:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/achievements/:id - Delete an achievement
router.delete('/achievements/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query('DELETE FROM achievements WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Achievement not found.' });
        }

        res.json({ message: 'Achievement deleted successfully.' });
    } catch (error) {
        console.error("Error deleting achievement:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});
// =================================================================

// =================================================================
// APIs FOR "SKILLS" PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/skills - Get all skill entries
router.get('/skills', verifyToken, async (req, res) => {
    try {
        // Order by category then by skill name for a logical grouping
        const [skillList] = await db.query('SELECT * FROM skills ORDER BY category, skill_name');
        res.json(skillList);
    } catch (error) {
        console.error("Error fetching skill list:", error);
        res.status(500).json({ message: 'Server error while fetching skills.' });
    }
});

// GET /api/admin/skills/:id - Get a single skill for editing
router.get('/skills/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM skills WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Skill not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single skill:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// POST /api/admin/skills - Create a new skill
router.post('/skills', verifyToken, async (req, res) => {
    try {
        const { skill_name, category } = req.body;
        const createdBy = req.user.email;

        if (!skill_name || !category) {
            return res.status(400).json({ message: 'Skill name and category are required.' });
        }

        const sql = `INSERT INTO skills (skill_name, category, createdBy) VALUES (?, ?, ?)`;
        await db.query(sql, [skill_name, category, createdBy]);
        
        res.status(201).json({ message: 'Skill created successfully.' });
    } catch (error) {
        console.error("Error creating skill:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/skills/:id - Update an existing skill
router.put('/skills/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { skill_name, category } = req.body;
        const updatedBy = req.user.email;

        if (!skill_name || !category) {
            return res.status(400).json({ message: 'Skill name and category are required.' });
        }

        const sql = `UPDATE skills SET skill_name=?, category=?, updatedBy=? WHERE id=?`;
        const [result] = await db.query(sql, [skill_name, category, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Skill not found or no changes made.' });
        }
        
        res.json({ message: 'Skill updated successfully.' });
    } catch (error) {
        console.error("Error updating skill:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/skills/:id - Delete a skill
router.delete('/skills/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query('DELETE FROM skills WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Skill not found.' });
        }

        res.json({ message: 'Skill deleted successfully.' });
    } catch (error) {
        console.error("Error deleting skill:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});
// =================================================================


// =================================================================
// APIs FOR "COURSES & CERTIFICATES" PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/courses - Get all course entries
router.get('/courses', verifyToken, async (req, res) => {
    try {
        // Order by ID descending to show the newest courses first
        const [courseList] = await db.query('SELECT * FROM courses_n_certificates ORDER BY id DESC');
        res.json(courseList);
    } catch (error) {
        console.error("Error fetching course list:", error);
        res.status(500).json({ message: 'Server error while fetching courses.' });
    }
});

// GET /api/admin/courses/:id - Get a single course for editing
router.get('/courses/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM courses_n_certificates WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Course or certificate not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single course:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// POST /api/admin/courses - Create a new course
router.post('/courses', verifyToken, async (req, res) => {
    try {
        const { course_name, issuer, certificate_url } = req.body;
        const createdBy = req.user.email;

        if (!course_name || !issuer) {
            return res.status(400).json({ message: 'Course name and issuer are required.' });
        }

        const sql = `INSERT INTO courses_n_certificates (course_name, issuer, certificate_url, createdBy) VALUES (?, ?, ?, ?)`;
        await db.query(sql, [course_name, issuer, certificate_url, createdBy]);
        
        res.status(201).json({ message: 'Course created successfully.' });
    } catch (error) {
        console.error("Error creating course:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/courses/:id - Update an existing course
router.put('/courses/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { course_name, issuer, certificate_url } = req.body;
        const updatedBy = req.user.email;

        if (!course_name || !issuer) {
            return res.status(400).json({ message: 'Course name and issuer are required.' });
        }

        const sql = `UPDATE courses_n_certificates SET course_name=?, issuer=?, certificate_url=?, updatedBy=? WHERE id=?`;
        const [result] = await db.query(sql, [course_name, issuer, certificate_url, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Course not found or no changes made.' });
        }
        
        res.json({ message: 'Course updated successfully.' });
    } catch (error) {
        console.error("Error updating course:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/courses/:id - Delete a course
router.delete('/courses/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query('DELETE FROM courses_n_certificates WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Course not found.' });
        }

        res.json({ message: 'Course deleted successfully.' });
    } catch (error) {
        console.error("Error deleting course:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});
// =================================================================

// =================================================================
// APIs FOR "REFERENCES" (REFERENCE_PERSON) PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/references - Get all reference entries
router.get('/references', verifyToken, async (req, res) => {
    try {
        // Order by ID descending to show the newest references first
        const [referenceList] = await db.query('SELECT * FROM reference_person ORDER BY id DESC');
        res.json(referenceList);
    } catch (error) {
        console.error("Error fetching reference list:", error);
        res.status(500).json({ message: 'Server error while fetching references.' });
    }
});

// GET /api/admin/references/:id - Get a single reference for editing
router.get('/references/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM reference_person WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Reference not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single reference:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// POST /api/admin/references - Create a new reference
router.post('/references', verifyToken, async (req, res) => {
    try {
        const { full_name, designation, organization, relation, email, phone } = req.body;
        const createdBy = req.user.email;

        if (!full_name || !designation || !organization) {
            return res.status(400).json({ message: 'Full name, designation, and organization are required.' });
        }

        const sql = `
            INSERT INTO reference_person 
            (full_name, designation, organization, relation, email, phone, createdBy) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        await db.query(sql, [full_name, designation, organization, relation, email, phone, createdBy]);
        
        res.status(201).json({ message: 'Reference created successfully.' });
    } catch (error) {
        console.error("Error creating reference:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/references/:id - Update an existing reference
router.put('/references/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { full_name, designation, organization, relation, email, phone } = req.body;
        const updatedBy = req.user.email;

        if (!full_name || !designation || !organization) {
            return res.status(400).json({ message: 'Full name, designation, and organization are required.' });
        }

        const sql = `
            UPDATE reference_person 
            SET full_name=?, designation=?, organization=?, relation=?, email=?, phone=?, updatedBy=? 
            WHERE id=?
        `;
        const [result] = await db.query(sql, [full_name, designation, organization, relation, email, phone, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Reference not found or no changes made.' });
        }
        
        res.json({ message: 'Reference updated successfully.' });
    } catch (error) {
        console.error("Error updating reference:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/references/:id - Delete a reference
router.delete('/references/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query('DELETE FROM reference_person WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Reference not found.' });
        }

        res.json({ message: 'Reference deleted successfully.' });
    } catch (error) {
        console.error("Error deleting reference:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// =================================================================
// APIs FOR "MEDIA" PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/media - Get all media entries
router.get('/media', verifyToken, async (req, res) => {
    try {
        // Order by ID descending to show the newest media first
        const [mediaList] = await db.query('SELECT * FROM media ORDER BY id DESC');
        res.json(mediaList);
    } catch (error) {
        console.error("Error fetching media list:", error);
        res.status(500).json({ message: 'Server error while fetching media.' });
    }
});

// GET /api/admin/media/:id - Get a single media entry for editing
router.get('/media/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM media WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Media item not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single media item:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// POST /api/admin/media - Create a new media entry
router.post('/media', verifyToken, upload.single('image'), async (req, res) => {
    try {
        const { caption, description } = req.body;
        const createdBy = req.user.email;
        
        if (!req.file) {
            return res.status(400).json({ message: 'An image file is required.' });
        }
        
        const img_url = req.file.path.replace('public/', '');

        const sql = `INSERT INTO media (caption, description, img_url, createdBy) VALUES (?, ?, ?, ?)`;
        await db.query(sql, [caption, description, img_url, createdBy]);
        
        res.status(201).json({ message: 'Media item created successfully.' });
    } catch (error) {
        console.error("Error creating media item:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/media/:id - Update an existing media entry
router.put('/media/:id', verifyToken, upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { caption, description, existingImageUrl } = req.body;
        const updatedBy = req.user.email;
        let img_url = existingImageUrl;

        // If a new file is uploaded, update the img_url and delete the old one
        if (req.file) {
            img_url = req.file.path.replace('public/', '');
            if (existingImageUrl) {
                const oldImagePath = path.join(__dirname, '..', 'public', existingImageUrl);
                try {
                    await fs.unlink(oldImagePath);
                } catch (err) {
                    console.error("Could not delete old media image:", err.message);
                }
            }
        }

        const sql = `UPDATE media SET caption=?, description=?, img_url=?, updatedBy=? WHERE id=?`;
        const [result] = await db.query(sql, [caption, description, img_url, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Media item not found or no changes made.' });
        }
        
        res.json({ message: 'Media item updated successfully.' });
    } catch (error) {
        console.error("Error updating media item:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/media/:id - Delete a media entry
router.delete('/media/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        // First, get the image URL to delete the file from the server
        const [rows] = await db.query('SELECT img_url FROM media WHERE id = ?', [id]);
        if (rows.length > 0 && rows[0].img_url) {
            const imagePath = path.join(__dirname, '..', 'public', rows[0].img_url);
            try {
                await fs.unlink(imagePath);
            } catch (err) {
                console.error("Could not delete media image file:", err.message);
            }
        }

        // Then, delete the record from the database
        const [result] = await db.query('DELETE FROM media WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Media item not found.' });
        }

        res.json({ message: 'Media item deleted successfully.' });
    } catch (error) {
        console.error("Error deleting media item:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// =================================================================
// APIs FOR "SOCIAL LINKS" PAGE (FULL CRUD)
// =================================================================

// GET /api/admin/social-links - Get all social link entries
router.get('/social-links', verifyToken, async (req, res) => {
    try {
        // Order by ID descending to show the newest links first
        const [links] = await db.query('SELECT * FROM social_links ORDER BY id DESC');
        res.json(links);
    } catch (error) {
        console.error("Error fetching social links:", error);
        res.status(500).json({ message: 'Server error while fetching social links.' });
    }
});

// GET /api/admin/social-links/:id - Get a single social link for editing
router.get('/social-links/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM social_links WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Social link not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single social link:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// POST /api/admin/social-links - Create a new social link
router.post('/social-links', verifyToken, upload.single('icon'), async (req, res) => {
    try {
        const { name, url } = req.body;
        const createdBy = req.user.email;
        
        if (!name || !url) {
            return res.status(400).json({ message: 'Name and URL are required.' });
        }
        
        // The icon is optional
        const icon_url = req.file ? req.file.path.replace('public/', '') : null;

        const sql = `INSERT INTO social_links (name, url, icon_url, createdBy) VALUES (?, ?, ?, ?)`;
        await db.query(sql, [name, url, icon_url, createdBy]);
        
        res.status(201).json({ message: 'Social link created successfully.' });
    } catch (error) {
        console.error("Error creating social link:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/social-links/:id - Update an existing social link
router.put('/social-links/:id', verifyToken, upload.single('icon'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, url, existingIconUrl } = req.body;
        const updatedBy = req.user.email;
        let icon_url = existingIconUrl;

        // If a new icon is uploaded, update the icon_url and delete the old one
        if (req.file) {
            icon_url = req.file.path.replace('public/', '');
            if (existingIconUrl) {
                const oldIconPath = path.join(__dirname, '..', 'public', existingIconUrl);
                try {
                    await fs.unlink(oldIconPath);
                } catch (err) {
                    console.error("Could not delete old social icon:", err.message);
                }
            }
        }

        const sql = `UPDATE social_links SET name=?, url=?, icon_url=?, updatedBy=? WHERE id=?`;
        const [result] = await db.query(sql, [name, url, icon_url, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Social link not found or no changes made.' });
        }
        
        res.json({ message: 'Social link updated successfully.' });
    } catch (error) {
        console.error("Error updating social link:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/social-links/:id - Delete a social link
router.delete('/social-links/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        // First, get the icon URL to delete the file from the server
        const [rows] = await db.query('SELECT icon_url FROM social_links WHERE id = ?', [id]);
        if (rows.length > 0 && rows[0].icon_url) {
            const iconPath = path.join(__dirname, '..', 'public', rows[0].icon_url);
            try {
                await fs.unlink(iconPath);
            } catch (err) {
                console.error("Could not delete social icon file:", err.message);
            }
        }

        // Then, delete the record from the database
        const [result] = await db.query('DELETE FROM social_links WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Social link not found.' });
        }

        res.json({ message: 'Social link deleted successfully.' });
    } catch (error) {
        console.error("Error deleting social link:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// =================================================================
// API FOR "RESET PASSWORD" PAGE
// =================================================================

// POST /api/admin/passreset - Changes the logged-in user's password
router.post('/passreset', verifyToken, async (req, res) => {
    try {
        const { email, oldPassword, newPassword } = req.body;

        // Get the logged-in user's ID and email from the verified JWT
        const loggedInUserId = req.user.id;
        const loggedInUserEmail = req.user.email;

        // --- Security Checks ---
        // 1. Ensure the email submitted in the form matches the logged-in user.
        // This prevents any confusion and adds a layer of validation.
        if (email !== loggedInUserEmail) {
            return res.status(403).json({ message: 'Authorization error. Submitted email does not match logged-in user.' });
        }

        // 2. Fetch the current user's hashed password from the database.
        const [userRows] = await db.query('SELECT password FROM users WHERE id = ?', [loggedInUserId]);
        if (userRows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        const currentHashedPassword = userRows[0].password;

        // 3. Compare the provided "oldPassword" with the one from the database.
        const isOldPasswordCorrect = await bcrypt.compare(oldPassword, currentHashedPassword);
        if (!isOldPasswordCorrect) {
            return res.status(401).json({ message: 'Incorrect old password.' });
        }

        // --- Update Password ---
        // If all checks pass, hash the new password.
        const saltRounds = 10; // Standard salt rounds for bcrypt
        const newHashedPassword = await bcrypt.hash(newPassword, saltRounds);

        // Update the database with the new hashed password.
        const sql = 'UPDATE users SET password = ?, updatedBy = ? WHERE id = ?';
        await db.query(sql, [newHashedPassword, loggedInUserEmail, loggedInUserId]);

        // Send a success response
        res.json({ message: 'Password has been updated successfully.' });

    } catch (error) {
        console.error("Password reset error:", error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// =================================================================
// APIs FOR "ENQUIRIES" PAGE (ADMIN MANAGEMENT)
// =================================================================

// GET /api/admin/enquiries - Get all enquiry entries
router.get('/enquiries', verifyToken, async (req, res) => {
    try {
        // Order by date descending to show the newest enquiries first
        const [enquiryList] = await db.query('SELECT * FROM enquiries ORDER BY date DESC, id DESC');
        res.json(enquiryList);
    } catch (error) {
        console.error("Error fetching enquiry list:", error);
        res.status(500).json({ message: 'Server error while fetching enquiries.' });
    }
});

// GET /api/admin/enquiries/:id - Get a single enquiry to view its full message
router.get('/enquiries/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM enquiries WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Enquiry not found.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching single enquiry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PUT /api/admin/enquiries/:id/status - Update the status of an enquiry
router.put('/enquiries/:id/status', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const updatedBy = req.user.email;

        // Validate the status to ensure it's one of the allowed values
        const allowedStatuses = ['pending', 'responded', 'prioritized'];
        if (!status || !allowedStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid status provided.' });
        }

        const sql = `UPDATE enquiries SET status=?, updatedBy=? WHERE id=?`;
        const [result] = await db.query(sql, [status, updatedBy, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Enquiry not found.' });
        }
        
        res.json({ message: `Enquiry status updated to "${status}".` });
    } catch (error) {
        console.error("Error updating enquiry status:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// DELETE /api/admin/enquiries/:id - Delete an enquiry
router.delete('/enquiries/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query('DELETE FROM enquiries WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Enquiry not found.' });
        }

        res.json({ message: 'Enquiry deleted successfully.' });
    } catch (error) {
        console.error("Error deleting enquiry:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

module.exports = router;