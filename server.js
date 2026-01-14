const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const fs = require('fs');
const multer = require('multer');


const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files including HTML

// Ensure uploads folder exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Serve uploaded images
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const safeExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.jpg';
    cb(null, `avatar_${Date.now()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const ok = (file.mimetype || '').startsWith('image/');
    if (!ok) return cb(new Error('Chỉ cho phép upload file ảnh'));
    cb(null, true);
  }
});


// Initialize SQLite database
const db = new sqlite3.Database('./nhansu.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');

    // Create employees table
    db.run(`
      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        maNv TEXT NOT NULL UNIQUE,
        hoTen TEXT NOT NULL,
        chucDanh TEXT,
        ngaySinh TEXT,
        gioiTinh TEXT,
        heSoLuong REAL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        console.error('Error creating table:', err.message);
      } else {
        console.log('Employees table ready');
        // ===== Add extra columns for employee profile page (safe, no data loss) =====
function ensureEmployeeProfileColumns() {
  db.all("PRAGMA table_info(employees)", [], (err, rows) => {
    if (err) return console.error("PRAGMA error:", err.message);

    const cols = rows.map(r => r.name);

    const addCol = (name, type) => {
      if (!cols.includes(name)) {
        db.run(`ALTER TABLE employees ADD COLUMN ${name} ${type}`, (e) => {
          if (e) console.error(`Add column ${name} error:`, e.message);
          else console.log(`Added column employees.${name}`);
        });
      }
    };

    addCol("email", "TEXT");
    addCol("soDienThoai", "TEXT");
    addCol("avatarUrl", "TEXT");
    addCol("trangThai", "TEXT");  // VD: Dang lam viec | Da khoa | Nghi viec
    addCol("maPb", "TEXT");       // VD: IT, HCNS, KD...
  });
}
ensureEmployeeProfileColumns();

      }
    });
  }
});

// Create departments table
db.run(`
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    maPb TEXT NOT NULL UNIQUE,
    tenPb TEXT NOT NULL,
    moTaPb TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) console.error('Error creating departments table:', err.message);
  else console.log('Departments table ready');
});

// Create users table
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    fullName TEXT NOT NULL,
    role TEXT NOT NULL,
    employeeCode TEXT,
    password TEXT,
    active INTEGER DEFAULT 1,
    lastLogin TEXT DEFAULT '-',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) console.error('Error creating users table:', err.message);
  else console.log('Users table ready');
});

// Create logs table
db.run(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL
  )
`, (err) => {
  if (err) console.error('Error creating logs table:', err.message);
  else console.log('Logs table ready');
});

// Create attendance table
db.run(`
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    maNv TEXT NOT NULL,
    workDate TEXT NOT NULL,          -- YYYY-MM-DD
    shiftCode TEXT,                  -- VD: HC1, HC71
    shiftTime TEXT,                  -- VD: 08:00-18:00
    checkIn TEXT,                    -- VD: 07:58
    checkOut TEXT,                   -- VD: 18:06
    explainStatus TEXT DEFAULT 'CHUA',-- CHUA | DA
    note TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(maNv, workDate)
  )
`, (err) => {
  if (err) console.error('Error creating attendance table:', err.message);
  else console.log('Attendance table ready');
});// ===================== ATTENDANCE API =====================

// GET attendance by range: /api/attendance?maNv=NV001&from=2025-12-23&to=2026-01-22
app.get('/api/attendance', (req, res) => {
  const { maNv, from, to } = req.query;

  if (!maNv || !from || !to) {
    return res.status(400).json({
      success: false,
      error: 'Thiếu tham số: maNv, from, to'
    });
  }

  const sql = `
    SELECT *
    FROM attendance
    WHERE maNv = ?
      AND workDate >= ?
      AND workDate <= ?
    ORDER BY workDate ASC
  `;

  db.all(sql, [maNv, from, to], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows });
  });
});


// POST UPSERT attendance: { maNv, workDate, shiftCode, shiftTime, checkIn, checkOut, explainStatus, note }
app.post('/api/attendance', (req, res) => {
  const {
    maNv,
    workDate,
    shiftCode,
    shiftTime,
    checkIn,
    checkOut,
    explainStatus,
    note
  } = req.body;

  if (!maNv || !workDate) {
    return res.status(400).json({
      success: false,
      error: 'Thiếu maNv hoặc workDate'
    });
  }

  // SQLite UPSERT (dựa vào UNIQUE(maNv, workDate))
  const sql = `
    INSERT INTO attendance (maNv, workDate, shiftCode, shiftTime, checkIn, checkOut, explainStatus, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(maNv, workDate) DO UPDATE SET
      shiftCode = excluded.shiftCode,
      shiftTime = excluded.shiftTime,
      checkIn = excluded.checkIn,
      checkOut = excluded.checkOut,
      explainStatus = excluded.explainStatus,
      note = excluded.note
  `;

  const params = [
    maNv,
    workDate,
    shiftCode || null,
    shiftTime || null,
    checkIn || null,
    checkOut || null,
    explainStatus || 'CHUA',
    note || null
  ];

  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ success: false, error: err.message });

    // lấy lại record sau upsert để frontend có id (nếu cần)
    db.get(
      `SELECT * FROM attendance WHERE maNv = ? AND workDate = ?`,
      [maNv, workDate],
      (e2, row) => {
        if (e2) return res.status(500).json({ success: false, error: e2.message });
        res.json({ success: true, message: 'Đã lưu chấm công', data: row });
      }
    );
  });
});


// DELETE attendance by id: /api/attendance/:id
app.delete('/api/attendance/:id', (req, res) => {
  const id = req.params.id;

  db.run(`DELETE FROM attendance WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (this.changes === 0) {
      return res.status(404).json({ success: false, error: 'Attendance not found' });
    }
    res.json({ success: true, message: 'Đã xóa chấm công' });
  });
});


// API Routes
// Summary timesheet (cards + rows) by range
app.get('/api/timesheet/summary', (req, res) => {
  const { maNv, from, to } = req.query;

  if (!maNv || !from || !to) {
    return res.status(400).json({ success: false, error: 'Thiếu tham số: maNv, from, to' });
  }

  const sql = `
    SELECT * FROM attendance
    WHERE maNv = ?
      AND workDate >= ?
      AND workDate <= ?
    ORDER BY workDate ASC
  `;

  db.all(sql, [maNv, from, to], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });

    // Demo quy đổi: nếu có checkIn+checkOut => công chuyên cần = 9h (giống ảnh)
    // Bạn có thể thay bằng công thức thật của dự án
    const rowMap = rows.reduce((acc, r) => {
      acc[r.workDate] = r;
      return acc;
    }, {});

    // Tạo danh sách ngày trong kỳ
    const dates = [];
    const start = new Date(from);
    const end = new Date(to);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dates.push(`${yyyy}-${mm}-${dd}`);
    }

    // Build table rows
    const tableRows = dates.map(dateStr => {
      const r = rowMap[dateStr];
      const d = new Date(dateStr);
      const dow = d.getDay(); // 0 CN..6 T7
      const label = (dow === 0) ? `CN - ${d.getDate()}` : `T${dow + 1} - ${d.getDate()}`;

      // demo: 9 giờ nếu có đủ vào/ra
      const ccc = (r && r.checkIn && r.checkOut) ? 9 : '-';

      return {
        time: label,
        ot: '-',
        truc: '-',
        ca3: '-',
        bhxh: '-',
        hl: '-',
        khl: '-',
        phep: '-',
        ccc: ccc,
        note: r?.note || ''
      };
    });

    // Tổng (demo)
    const totalCCC = tableRows
      .filter(x => typeof x.ccc === 'number')
      .reduce((s, x) => s + x.ccc, 0);

    // Cards (demo)
    const cards = {
      tongCong: String(totalCCC).replace('.', ','),
      congChuan: '27,25',
      congTon: '--',
      phepKhaDung: '0',
      phepDaDung: '0'
    };

    res.json({
      success: true,
      data: { cards, rows: [{ time: 'Tổng', ot:'-', truc:'-', ca3:'-', bhxh:'-', hl:'-', khl:'-', phep:'-', ccc: totalCCC || '-', note:'' }, ...tableRows] }
    });
  });
});



// Upload avatar for an employee (multipart/form-data)
app.post('/api/employees/:id/avatar', upload.single('avatar'), (req, res) => {
  const employeeId = req.params.id;

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Không có file ảnh' });
  }

  const avatarUrl = `/uploads/${req.file.filename}`;

  // Update DB
  db.run(
    `UPDATE employees SET avatarUrl = ? WHERE id = ?`,
    [avatarUrl, employeeId],
    function (err) {
      if (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ success: false, error: 'Employee not found' });
      }
      res.json({ success: true, data: { avatarUrl } });
    }
  );
});

// Get all employees
app.get('/api/employees', (req, res) => {
const sql = `
   SELECT *
    FROM employees
    ORDER BY CAST(
      REPLACE(maNv, 'NV', '')
      AS INTEGER
    ) ASC
`;

  db.all(sql, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({
      success: true,
      data: rows
    });
  });
});

// Get employee by ID
app.get('/api/employees/:id', (req, res) => {
  const sql = 'SELECT * FROM employees WHERE id = ?';

  db.get(sql, [req.params.id], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!row) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }
    res.json({
      success: true,
      data: row
    });
  });
});

// Create new employee
app.post('/api/employees', (req, res) => {
  const { maNv, hoTen, chucDanh, ngaySinh, gioiTinh, heSoLuong } = req.body;

  // Validation
  if (!maNv || !hoTen) {
    res.status(400).json({
      success: false,
      error: 'Mã nhân viên và Họ tên là bắt buộc'
    });
    return;
  }

  const sql = `
    INSERT INTO employees (maNv, hoTen, chucDanh, ngaySinh, gioiTinh, heSoLuong)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  const params = [maNv, hoTen, chucDanh, ngaySinh, gioiTinh, heSoLuong];

  db.run(sql, params, function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        res.status(400).json({
          success: false,
          error: 'Mã nhân viên đã tồn tại'
        });
      } else {
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
      return;
    }

    res.json({
      success: true,
      message: 'Đã thêm nhân viên thành công',
      data: {
        id: this.lastID,
        maNv,
        hoTen,
        chucDanh,
        ngaySinh,
        gioiTinh,
        heSoLuong
      }
    });
  });
});

// Update employee
app.put('/api/employees/:id', (req, res) => {
  const { maNv, hoTen, chucDanh, ngaySinh, gioiTinh, heSoLuong } = req.body;

  const sql = `
    UPDATE employees
    SET maNv = ?, hoTen = ?, chucDanh = ?, ngaySinh = ?, gioiTinh = ?, heSoLuong = ?
    WHERE id = ?
  `;

  const params = [maNv, hoTen, chucDanh, ngaySinh, gioiTinh, heSoLuong, req.params.id];

  db.run(sql, params, function(err) {
    if (err) {
      res.status(500).json({
        success: false,
        error: err.message
      });
      return;
    }

    if (this.changes === 0) {
      res.status(404).json({
        success: false,
        error: 'Employee not found'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Cập nhật thành công'
    });
  });
});

// Delete employee
app.delete('/api/employees/:id', (req, res) => {
  const sql = 'DELETE FROM employees WHERE id = ?';

  db.run(sql, [req.params.id], function(err) {
    if (err) {
      res.status(500).json({
        success: false,
        error: err.message
      });
      return;
    }

    if (this.changes === 0) {
      res.status(404).json({
        success: false,
        error: 'Employee not found'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Đã xóa nhân viên'
    });
  });
});

// Get statistics
app.get('/api/statistics', (req, res) => {
  const queries = {
    total: 'SELECT COUNT(*) as count FROM employees',
    male: 'SELECT COUNT(*) as count FROM employees WHERE gioiTinh = "Nam"',
    female: 'SELECT COUNT(*) as count FROM employees WHERE gioiTinh = "Nữ"',
    noSalary: 'SELECT COUNT(*) as count FROM employees WHERE heSoLuong IS NULL OR heSoLuong = ""'
  };

  const stats = {};
  let completed = 0;

  Object.keys(queries).forEach(key => {
    db.get(queries[key], [], (err, row) => {
      if (!err) {
        stats[key] = row.count;
      }
      completed++;

      if (completed === Object.keys(queries).length) {
        res.json({
          success: true,
          data: stats
        });
      }
    });
  });
});

// ===================== DEPARTMENTS API =====================

// Get all departments + count employees by department code (OPTION)
app.get('/api/departments', (req, res) => {
  const sql = `
    SELECT 
      d.*,
      (SELECT COUNT(*) FROM employees e WHERE e.chucDanh = d.maPb) as soLuongNhanSu
    FROM departments d
    ORDER BY d.maPb ASC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      res.status(500).json({ success: false, error: err.message });
      return;
    }
    res.json({ success: true, data: rows });
  });
});

// Get department by id
app.get('/api/departments/:id', (req, res) => {
  const sql = `SELECT * FROM departments WHERE id = ?`;
  db.get(sql, [req.params.id], (err, row) => {
    if (err) {
      res.status(500).json({ success: false, error: err.message });
      return;
    }
    if (!row) {
      res.status(404).json({ success: false, error: 'Department not found' });
      return;
    }
    res.json({ success: true, data: row });
  });
});

// Create new department
app.post('/api/departments', (req, res) => {
  const { maPb, tenPb, moTaPb } = req.body;

  if (!maPb || !tenPb) {
    res.status(400).json({ success: false, error: 'Mã phòng ban và Tên phòng ban là bắt buộc' });
    return;
  }

  const sql = `
    INSERT INTO departments (maPb, tenPb, moTaPb)
    VALUES (?, ?, ?)
  `;
  const params = [maPb.trim().toUpperCase(), tenPb.trim(), (moTaPb || '').trim()];

  db.run(sql, params, function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        res.status(400).json({ success: false, error: 'Mã phòng ban đã tồn tại' });
      } else {
        res.status(500).json({ success: false, error: err.message });
      }
      return;
    }

    res.json({
      success: true,
      message: 'Đã thêm phòng ban thành công',
      data: { id: this.lastID, maPb: params[0], tenPb: params[1], moTaPb: params[2] }
    });
  });
});

// Update department
app.put('/api/departments/:id', (req, res) => {
  const { maPb, tenPb, moTaPb } = req.body;

  if (!maPb || !tenPb) {
    res.status(400).json({ success: false, error: 'Mã phòng ban và Tên phòng ban là bắt buộc' });
    return;
  }

  const sql = `
    UPDATE departments
    SET maPb = ?, tenPb = ?, moTaPb = ?
    WHERE id = ?
  `;
  const params = [maPb.trim().toUpperCase(), tenPb.trim(), (moTaPb || '').trim(), req.params.id];

  db.run(sql, params, function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        res.status(400).json({ success: false, error: 'Mã phòng ban đã tồn tại' });
      } else {
        res.status(500).json({ success: false, error: err.message });
      }
      return;
    }

    if (this.changes === 0) {
      res.status(404).json({ success: false, error: 'Department not found' });
      return;
    }

    res.json({ success: true, message: 'Cập nhật phòng ban thành công' });
  });
});

// Delete department
app.delete('/api/departments/:id', (req, res) => {
  const sql = `DELETE FROM departments WHERE id = ?`;

  db.run(sql, [req.params.id], function(err) {
    if (err) {
      res.status(500).json({ success: false, error: err.message });
      return;
    }

    if (this.changes === 0) {
      res.status(404).json({ success: false, error: 'Department not found' });
      return;
    }

    res.json({ success: true, message: 'Đã xóa phòng ban' });
  });
});

// ===================== USERS API =====================

// Get all users
app.get('/api/users', (req, res) => {
  const sql = `SELECT * FROM users ORDER BY username ASC`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows });
  });
});

// Create new user
app.post('/api/users', (req, res) => {
  const { username, fullName, role, employeeCode, password } = req.body;

  if (!username || !fullName || !role) {
    return res.status(400).json({ success: false, error: 'Username, Họ tên, Role là bắt buộc' });
  }

  const u = String(username).trim();
  const fn = String(fullName).trim();
  const r = String(role).trim();
  const ec = (employeeCode || '').trim();
  const pw = password || '';

  const sql = `
    INSERT INTO users (username, fullName, role, employeeCode, password, active, lastLogin)
    VALUES (?, ?, ?, ?, ?, 1, '-')
  `;

  db.run(sql, [u, fn, r, ec, pw], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE') || err.message.includes('PRIMARY KEY')) {
        return res.status(400).json({ success: false, error: 'Username đã tồn tại' });
      }
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true, message: 'Tạo user thành công' });
  });
});

// Update user by username
app.put('/api/users/:username', (req, res) => {
  const { fullName, role, employeeCode } = req.body;

  const u = String(req.params.username).trim();
  if (!u) return res.status(400).json({ success: false, error: 'Username không hợp lệ' });

  if (!fullName || !role) {
    return res.status(400).json({ success: false, error: 'Họ tên và Role là bắt buộc' });
  }

  const sql = `
    UPDATE users
    SET fullName = ?, role = ?, employeeCode = ?
    WHERE username = ?
  `;
  const params = [String(fullName).trim(), String(role).trim(), (employeeCode || '').trim(), u];

  db.run(sql, params, function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (this.changes === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, message: 'Cập nhật user thành công' });
  });
});

// Toggle status (active/locked)
app.patch('/api/users/:username/status', (req, res) => {
  const u = String(req.params.username).trim();
  const { active } = req.body; // boolean

  const newVal = active ? 1 : 0;

  const sql = `UPDATE users SET active = ? WHERE username = ?`;
  db.run(sql, [newVal, u], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (this.changes === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, message: 'Cập nhật trạng thái thành công' });
  });
});

// Reset password (demo: set new password)
app.post('/api/users/:username/reset-password', (req, res) => {
  const u = String(req.params.username).trim();
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ success: false, error: 'Thiếu newPassword' });

  const sql = `UPDATE users SET password = ? WHERE username = ?`;
  db.run(sql, [String(newPassword), u], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (this.changes === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, message: 'Reset mật khẩu thành công (demo)' });
  });
});

// Delete user
app.delete('/api/users/:username', (req, res) => {
  const u = String(req.params.username).trim();
  const sql = `DELETE FROM users WHERE username = ?`;

  db.run(sql, [u], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (this.changes === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, message: 'Đã xóa user' });
  });
});


// ===================== LOGS API =====================

// Get logs (latest 50)
app.get('/api/logs', (req, res) => {
  const sql = `SELECT * FROM logs ORDER BY id DESC LIMIT 50`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows });
  });
});

// Add log
app.post('/api/logs', (req, res) => {
  const { actor, action } = req.body;
  if (!actor || !action) {
    return res.status(400).json({ success: false, error: 'Thiếu actor/action' });
  }

  const now = new Date();
  const timeStr =
    now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0") + " " +
    String(now.getHours()).padStart(2, "0") + ":" +
    String(now.getMinutes()).padStart(2, "0");

  const sql = `INSERT INTO logs (time, actor, action) VALUES (?, ?, ?)`;
  db.run(sql, [timeStr, String(actor), String(action)], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, message: 'Logged' });
  });
});


// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/nhansu.html to view the application`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Database connection closed');
    process.exit(0);
  });
});
