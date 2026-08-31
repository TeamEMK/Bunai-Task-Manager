// ══════════════════════════════════════════════════════
// SCHEMA — the single description of every table, column and index.
//
// It is DATA, not code: migrations.js reads it, compares it with what the
// database actually has (via information_schema) and issues only the DDL that
// is missing. That is why a warm restart costs three metadata queries instead
// of sixty ALTERs that all fail with "duplicate column".
// ══════════════════════════════════════════════════════

// Order matters only in that tables are created before their columns/indexes.
const TABLES = [
  ['users', `CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    notification_email VARCHAR(255) DEFAULT '',
    password VARCHAR(255) NOT NULL,
    role ENUM('admin','hod','pc','user') DEFAULT 'user',
    user_role ENUM('admin','hod','pc','user') DEFAULT NULL,
    phone VARCHAR(50) DEFAULT NULL,
    department VARCHAR(255) DEFAULT '',
    week_off VARCHAR(50) DEFAULT '',
    extra_off TEXT,
    exclude_from_reminder TINYINT(1) DEFAULT 0,
    profile_image LONGTEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // HR employee master (Phase 1). One record per employee. user_id links it to
  // the login account when there is one, but is nullable so non-login staff
  // (interns, field, ex-employees) can still be recorded. Admin-only data —
  // holds PII (Aadhaar/PAN/bank) and salary.
  ['hr_employees', `CREATE TABLE hr_employees (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT DEFAULT NULL,
    employee_code VARCHAR(60) DEFAULT NULL,
    full_name VARCHAR(200) NOT NULL,
    gender ENUM('male','female','other') DEFAULT NULL,
    dob DATE DEFAULT NULL,
    blood_group VARCHAR(10) DEFAULT NULL,
    marital_status VARCHAR(20) DEFAULT NULL,
    personal_email VARCHAR(160) DEFAULT NULL,
    personal_phone VARCHAR(40) DEFAULT NULL,
    current_address VARCHAR(500) DEFAULT NULL,
    permanent_address VARCHAR(500) DEFAULT NULL,
    emergency_contact_name VARCHAR(160) DEFAULT NULL,
    emergency_contact_phone VARCHAR(40) DEFAULT NULL,
    emergency_contact_relation VARCHAR(60) DEFAULT NULL,
    designation VARCHAR(160) DEFAULT NULL,
    department VARCHAR(160) DEFAULT NULL,
    joining_date DATE DEFAULT NULL,
    employment_type VARCHAR(40) DEFAULT NULL,
    employment_status VARCHAR(40) NOT NULL DEFAULT 'Active',
    reporting_manager VARCHAR(160) DEFAULT NULL,
    work_location VARCHAR(160) DEFAULT NULL,
    exit_date DATE DEFAULT NULL,
    pan VARCHAR(20) DEFAULT NULL,
    aadhaar VARCHAR(20) DEFAULT NULL,
    uan VARCHAR(30) DEFAULT NULL,
    pf_number VARCHAR(40) DEFAULT NULL,
    esic_number VARCHAR(40) DEFAULT NULL,
    bank_name VARCHAR(120) DEFAULT NULL,
    bank_account VARCHAR(40) DEFAULT NULL,
    bank_ifsc VARCHAR(20) DEFAULT NULL,
    bank_holder_name VARCHAR(160) DEFAULT NULL,
    ctc DECIMAL(12,2) DEFAULT NULL,
    monthly_salary DECIMAL(12,2) DEFAULT NULL,
    official_email VARCHAR(160) DEFAULT NULL,
    kra TEXT DEFAULT NULL,
    offer_letter_date VARCHAR(120) DEFAULT NULL,
    probation_end_date DATE DEFAULT NULL,
    confirmation_date DATE DEFAULT NULL,
    appointment_nda_status VARCHAR(120) DEFAULT NULL,
    code_of_conduct_status VARCHAR(120) DEFAULT NULL,
    policy_handbook_status VARCHAR(120) DEFAULT NULL,
    bg_verification_status VARCHAR(120) DEFAULT NULL,
    record_log TEXT DEFAULT NULL,
    performance_remarks TEXT DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // Created before the task tables because both carry a client_id.
  ['clients', `CREATE TABLE clients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    handler_id INT DEFAULT NULL,
    logo_url LONGTEXT DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['delegation_tasks', `CREATE TABLE delegation_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    description TEXT NOT NULL,
    assigned_to INT NOT NULL,
    assigned_by INT NOT NULL,
    due_date DATE,
    status ENUM('pending','completed','revised') DEFAULT 'pending',
    priority ENUM('low','medium','high') DEFAULT 'low',
    approval ENUM('yes','no') DEFAULT 'no',
    waiting_approval TINYINT(1) DEFAULT 0,
    approver_id INT DEFAULT NULL,
    remarks TEXT DEFAULT NULL,
    revise_reason TEXT,
    client_id INT DEFAULT NULL,
    url VARCHAR(2048) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['checklist_tasks', `CREATE TABLE checklist_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    description TEXT NOT NULL,
    assigned_to INT NOT NULL,
    assigned_by INT NOT NULL,
    due_date DATE,
    end_date DATE DEFAULT NULL,
    frequency VARCHAR(20) DEFAULT NULL,
    status ENUM('pending','completed') DEFAULT 'pending',
    priority ENUM('low','medium','high') DEFAULT 'low',
    remarks TEXT DEFAULT NULL,
    revise_reason TEXT,
    client_id INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['task_approvals', `CREATE TABLE task_approvals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    task_type VARCHAR(20) NOT NULL,
    requested_by INT NOT NULL,
    requested_to INT NOT NULL,
    action_type VARCHAR(50) DEFAULT NULL,
    status ENUM('pending','approved','rejected') DEFAULT 'pending',
    note TEXT DEFAULT NULL,
    new_date DATE DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['task_comments', `CREATE TABLE task_comments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    task_type VARCHAR(20) NOT NULL,
    user_id INT NOT NULL,
    comment TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['task_transfers', `CREATE TABLE task_transfers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    task_type VARCHAR(20) NOT NULL,
    from_user INT NOT NULL,
    to_user INT NOT NULL,
    requested_by INT NOT NULL,
    status ENUM('pending','approved','rejected') DEFAULT 'pending',
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // The UNIQUE (log_date, kind) key lets only one instance run the daily job.
  ['whatsapp_reminder_log', `CREATE TABLE whatsapp_reminder_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    log_date DATE NOT NULL,
    kind VARCHAR(40) NOT NULL,
    status VARCHAR(20) DEFAULT 'running',
    sent INT DEFAULT 0,
    failed INT DEFAULT 0,
    note VARCHAR(500) DEFAULT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uniq_day_kind (log_date, kind)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['fms_sheets', `CREATE TABLE fms_sheets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fms_name VARCHAR(255) DEFAULT '',
    sheet_name VARCHAR(255) NOT NULL,
    sheet_id VARCHAR(255) NOT NULL,
    header_row INT DEFAULT 1,
    total_steps INT DEFAULT 0,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['fms_steps', `CREATE TABLE fms_steps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fms_id INT NOT NULL,
    step_order INT NOT NULL,
    step_name VARCHAR(255) NOT NULL,
    plan_col VARCHAR(10) DEFAULT '',
    actual_col VARCHAR(10) DEFAULT '',
    extra_input VARCHAR(10) DEFAULT 'no',
    extra_col VARCHAR(10) DEFAULT '',
    show_cols TEXT,
    delay_reason_col VARCHAR(10) DEFAULT '',
    doer_name_col VARCHAR(10) DEFAULT ''
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['fms_step_doers', `CREATE TABLE fms_step_doers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    step_id INT NOT NULL,
    user_id INT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['fms_extra_rows', `CREATE TABLE fms_extra_rows (
    id INT AUTO_INCREMENT PRIMARY KEY,
    step_id INT NOT NULL,
    row_label VARCHAR(255) DEFAULT '',
    col_letter VARCHAR(10) DEFAULT '',
    field_type VARCHAR(20) DEFAULT 'text',
    dropdown_options TEXT,
    required TINYINT(1) DEFAULT 1
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['week_plans', `CREATE TABLE week_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employee_id INT NOT NULL,
    hod_id INT,
    start_date DATE NOT NULL,
    target_count INT DEFAULT 0,
    improvement_pct DECIMAL(5,2) DEFAULT 0,
    user_committed_score DECIMAL(5,1) DEFAULT NULL,
    user_committed_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_emp_week (employee_id, start_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['holidays', `CREATE TABLE holidays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    holiday_date DATE NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_by INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['leave_requests', `CREATE TABLE leave_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    leave_type ENUM('full_day','half_day','work_from_home','extra_working') NOT NULL,
    from_date DATE NOT NULL,
    to_date DATE NOT NULL,
    dates_json TEXT DEFAULT NULL,
    reason TEXT NOT NULL,
    status ENUM('pending','approved','rejected') DEFAULT 'pending',
    approver_id INT DEFAULT NULL,
    approver_note TEXT DEFAULT NULL,
    decided_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

];

// Columns added after a table first shipped. [table, column, DDL fragment]
// A database created from TABLES above already has all of them — the lookup in
// migrations.js skips every one of these on a modern schema.
const COLUMNS = [
  ['users', 'notification_email', `VARCHAR(255) DEFAULT '' AFTER email`],
  // user_role — separate from app `role`. Decides leave-approval hierarchy
  // (e.g. an IT person may have app role 'admin' but user role 'user',
  // so their leave still goes to their HOD).
  ['users', 'user_role', `ENUM('admin','hod','pc','user') DEFAULT NULL AFTER role`],
  ['users', 'department', `VARCHAR(255) DEFAULT '' AFTER phone`],
  ['users', 'week_off', `VARCHAR(50) DEFAULT '' AFTER department`],
  // No DEFAULT: MySQL rejects a default on TEXT/BLOB (error 1101), which made
  // this ALTER fail silently and left every query selecting extra_off broken.
  ['users', 'extra_off', `TEXT AFTER week_off`],
  ['users', 'exclude_from_reminder', `TINYINT(1) DEFAULT 0 AFTER extra_off`],
  ['users', 'profile_image', `LONGTEXT DEFAULT NULL`],

  // Who owns this unit. Employee 360 lists the units an employee handles and
  // scores them on how many are still active.
  ['clients', 'handler_id', `INT DEFAULT NULL AFTER name`],
  ['clients', 'logo_url', `LONGTEXT DEFAULT NULL AFTER handler_id`],
  ['clients', 'is_active', `TINYINT(1) NOT NULL DEFAULT 1 AFTER logo_url`],

  // Approver: the specific user chosen to approve a delegation task's completion
  // / revision. Kept separate from assigned_by (the delegator) so the doer can
  // never be the approver.
  ['delegation_tasks', 'approver_id', `INT DEFAULT NULL AFTER waiting_approval`],
  // Why a revision was requested. It used to be dropped whenever the task did
  // not need approval — the person typed a reason and it went nowhere.
  ['delegation_tasks', 'revise_reason', `TEXT AFTER remarks`],
  ['delegation_tasks', 'client_id', `INT DEFAULT NULL AFTER remarks`],
  ['delegation_tasks', 'url', `VARCHAR(2048) DEFAULT NULL AFTER client_id`],
  // Overdue reminders. NULL means none sent yet, so the first reminder fires on
  // the 12-hours-overdue rule and every one after it on the 8-hour rule. Stored
  // in UTC and always compared against a UTC string built in JS, so the DB
  // server's own timezone never enters into it.
  ['delegation_tasks', 'last_reminder_at', `DATETIME DEFAULT NULL AFTER url`],
  ['delegation_tasks', 'reminder_count', `INT NOT NULL DEFAULT 0 AFTER last_reminder_at`],

  // Checklist series metadata — end_date = the series' last date,
  // frequency = daily/weekly/monthly… Both are stored on every row of a series
  // so the "which checklist to delete" list can be built.
  ['checklist_tasks', 'end_date', `DATE DEFAULT NULL AFTER due_date`],
  ['checklist_tasks', 'frequency', `VARCHAR(20) DEFAULT NULL AFTER end_date`],
  ['checklist_tasks', 'revise_reason', `TEXT AFTER remarks`],
  ['checklist_tasks', 'client_id', `INT DEFAULT NULL AFTER remarks`],

  // Pending revised date — held on the approval request until it is approved.
  ['task_approvals', 'new_date', `DATE DEFAULT NULL AFTER note`],

  ['fms_sheets', 'fms_name', `VARCHAR(255) DEFAULT '' AFTER id`],
  ['fms_steps', 'show_cols', `TEXT AFTER extra_col`],
  ['fms_steps', 'delay_reason_col', `VARCHAR(10) DEFAULT '' AFTER show_cols`],
  ['fms_steps', 'doer_name_col', `VARCHAR(10) DEFAULT '' AFTER delay_reason_col`],
  ['fms_extra_rows', 'col_letter', `VARCHAR(10) DEFAULT '' AFTER row_label`],
  ['fms_extra_rows', 'field_type', `VARCHAR(20) DEFAULT 'text' AFTER col_letter`],
  ['fms_extra_rows', 'dropdown_options', `TEXT AFTER field_type`],
  // Required flag — default 1 so existing rows continue to be mandatory.
  ['fms_extra_rows', 'required', `TINYINT(1) DEFAULT 1 AFTER dropdown_options`],

  // The weekly check-in: what the employee committed to for that Monday.
  ['week_plans', 'improvement_pct', `DECIMAL(5,2) DEFAULT 0`],
  ['week_plans', 'user_committed_score', `DECIMAL(5,1) DEFAULT NULL AFTER improvement_pct`],
  ['week_plans', 'user_committed_at', `TIMESTAMP NULL DEFAULT NULL AFTER user_committed_score`],

  ['leave_requests', 'dates_json', `TEXT DEFAULT NULL AFTER to_date`],

  // hr_employees — onboarding / lifecycle fields added after the table shipped,
  // to match the client's existing HR tracker sheet.
  ['hr_employees', 'official_email', `VARCHAR(160) DEFAULT NULL`],
  ['hr_employees', 'kra', `TEXT DEFAULT NULL`],
  ['hr_employees', 'offer_letter_date', `VARCHAR(120) DEFAULT NULL`],
  ['hr_employees', 'probation_end_date', `DATE DEFAULT NULL`],
  ['hr_employees', 'confirmation_date', `DATE DEFAULT NULL`],
  ['hr_employees', 'appointment_nda_status', `VARCHAR(120) DEFAULT NULL`],
  ['hr_employees', 'code_of_conduct_status', `VARCHAR(120) DEFAULT NULL`],
  ['hr_employees', 'policy_handbook_status', `VARCHAR(120) DEFAULT NULL`],
  ['hr_employees', 'bg_verification_status', `VARCHAR(120) DEFAULT NULL`],
  ['hr_employees', 'record_log', `TEXT DEFAULT NULL`],
  ['hr_employees', 'performance_remarks', `TEXT DEFAULT NULL`],
];

// ══════════════════════════════════════════════════════
// INDEXES
// Every entry below exists because a query in src/routes filters, joins or
// sorts on exactly those columns in exactly that order. The comment names it.
//   [table, index name, column list, { unique }]
// ══════════════════════════════════════════════════════
const INDEXES = [
  // ── hr_employees ──
  // Employee code is the human key — unique, but nullable (many NULLs allowed).
  ['hr_employees', 'uq_employee_code', 'employee_code', { unique: true }],
  // Link back to the login account, and the default list ordering.
  ['hr_employees', 'idx_user', 'user_id'],
  ['hr_employees', 'idx_status_name', 'employment_status, full_name'],

  // ── users ──
  // HOD scoping: "SELECT id FROM users WHERE department=? AND role NOT IN (…)"
  ['users', 'idx_department', 'department'],
  ['users', 'idx_dept_role', 'department, role'],
  // /api/users lists ORDER BY role DESC, name ASC
  ['users', 'idx_role_name', 'role, name'],

  // ── delegation_tasks ──
  ['delegation_tasks', 'idx_assigned_to', 'assigned_to'],
  ['delegation_tasks', 'idx_status', 'status'],
  ['delegation_tasks', 'idx_due_date', 'due_date'],
  ['delegation_tasks', 'idx_approver', 'approver_id'],
  ['delegation_tasks', 'idx_client', 'client_id'],
  // Dashboard / MIS / Employee 360: one person's work inside a date window,
  // ordered by due date. This is the single hottest access path in the app.
  ['delegation_tasks', 'idx_assigned_due', 'assigned_to, due_date'],
  // …and the same with the status filter folded in (pending/completed cards).
  ['delegation_tasks', 'idx_assigned_status_due', 'assigned_to, status, due_date'],
  // Admin dashboard (no user filter): status + date window across everyone.
  ['delegation_tasks', 'idx_status_due', 'status, due_date'],
  // "Delegated by me" view.
  ['delegation_tasks', 'idx_assigned_by_due', 'assigned_by, due_date'],
  // Employee 360 unit rollup: per-client totals inside a window.
  ['delegation_tasks', 'idx_client_due', 'client_id, due_date'],

  // ── checklist_tasks ──
  ['checklist_tasks', 'idx_assigned_to', 'assigned_to'],
  ['checklist_tasks', 'idx_status', 'status'],
  ['checklist_tasks', 'idx_due_date', 'due_date'],
  ['checklist_tasks', 'idx_end_date', 'end_date'],
  ['checklist_tasks', 'idx_client', 'client_id'],
  ['checklist_tasks', 'idx_assigned_due', 'assigned_to, due_date'],
  ['checklist_tasks', 'idx_assigned_status_due', 'assigned_to, status, due_date'],
  // Daily 10 AM reminder: WHERE status='pending' AND due_date=?
  ['checklist_tasks', 'idx_status_due', 'status, due_date'],
  ['checklist_tasks', 'idx_assigned_by_due', 'assigned_by, due_date'],
  ['checklist_tasks', 'idx_client_due', 'client_id, due_date'],
  // Checklist SERIES operations (group list, group delete, set-end-date) filter
  // on assigned_to + description + frequency. description is TEXT, so a 191-char
  // prefix is the most an index can carry — enough to make these seeks.
  ['checklist_tasks', 'idx_series', 'assigned_to, description(191), frequency'],

  // ── task_approvals ──
  ['task_approvals', 'idx_task', 'task_id, task_type'],
  ['task_approvals', 'idx_requested_to', 'requested_to'],
  // Badge count + inbox: WHERE requested_to=? AND status='pending'
  ['task_approvals', 'idx_requested_to_status', 'requested_to, status'],
  ['task_approvals', 'idx_status_created', 'status, created_at'],
  // "is one already pending for this task?" — checked on every status change.
  ['task_approvals', 'idx_task_status', 'task_id, task_type, status'],

  // ── task_comments ──
  ['task_comments', 'idx_task', 'task_id, task_type'],
  ['task_comments', 'idx_user', 'user_id'],

  // ── task_transfers ── (this table had NO indexes at all)
  ['task_transfers', 'idx_status_created', 'status, created_at'],
  ['task_transfers', 'idx_task_status', 'task_id, task_type, status'],
  ['task_transfers', 'idx_requested_by', 'requested_by, status'],
  ['task_transfers', 'idx_from_user', 'from_user, status'],
  ['task_transfers', 'idx_to_user', 'to_user, status'],

  // ── FMS ──
  ['fms_steps', 'idx_fms', 'fms_id'],
  ['fms_steps', 'idx_fms_order', 'fms_id, step_order'],
  ['fms_step_doers', 'idx_step', 'step_id'],
  ['fms_step_doers', 'idx_user', 'user_id'],
  // Batched doer fetch: WHERE step_id IN (…) — covering, so no row lookups.
  ['fms_step_doers', 'idx_step_user', 'step_id, user_id'],
  ['fms_extra_rows', 'idx_step', 'step_id'],

  // ── week_plans ──
  ['week_plans', 'idx_employee', 'employee_id'],
  ['week_plans', 'idx_start', 'start_date'],
  // Employee 360 weekly table reads one employee across a list of Mondays, and
  // saving a plan is an INSERT … ON DUPLICATE KEY UPDATE — which silently
  // inserts duplicates unless this UNIQUE key exists. Older databases were
  // created without it; migrations.js adds it only when the data allows.
  ['week_plans', 'uq_emp_week', 'employee_id, start_date', { unique: true }],

  // ── holidays ──
  ['holidays', 'idx_date', 'holiday_date'],

  // ── leave_requests ──
  ['leave_requests', 'idx_user', 'user_id'],
  ['leave_requests', 'idx_status', 'status'],
  ['leave_requests', 'idx_approver', 'approver_id'],
  ['leave_requests', 'idx_from', 'from_date'],
  // Approval inbox + badge: WHERE approver_id IN (…) AND status='pending'
  ['leave_requests', 'idx_approver_status', 'approver_id, status'],
  ['leave_requests', 'idx_user_status', 'user_id, status'],
  // Every listing ends with ORDER BY created_at DESC LIMIT 500.
  ['leave_requests', 'idx_created', 'created_at'],

  // ── clients ──
  ['clients', 'idx_handler', 'handler_id'],
  ['clients', 'idx_active_name', 'is_active, name'],
];

// Data fixes that must run after the columns exist. Cheap and idempotent.
const BACKFILLS = [
  [`UPDATE users SET user_role=role WHERE user_role IS NULL`, 'backfill user_role from role'],
  // Older rows stored the approver inside assigned_by — recover it where approval was required.
  [`UPDATE delegation_tasks SET approver_id=assigned_by WHERE approval='yes' AND approver_id IS NULL`, 'backfill approver_id'],
  // Overdue reminders started on 2026-08-27. Every task that already existed
  // then is marked as "just reminded" so the feature begins from that day
  // instead of chasing years of backlog the moment it goes live.
  //
  // The created_at cutoff is load-bearing, not decoration. These backfills run
  // on EVERY boot, and a new task also has last_reminder_at IS NULL — without
  // the date this would mute every fresh task on every restart and no reminder
  // would ever fire. With it, the statement matches nothing after the first run.
  [`UPDATE delegation_tasks SET last_reminder_at = UTC_TIMESTAMP()
     WHERE last_reminder_at IS NULL AND created_at < '2026-08-27 00:00:00'`,
   'mute pre-launch tasks for overdue reminders'],
];

module.exports = { TABLES, COLUMNS, INDEXES, BACKFILLS };
