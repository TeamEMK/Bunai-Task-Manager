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

  ['daily_tasks', `CREATE TABLE daily_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    entry_date DATE NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    department VARCHAR(255) DEFAULT '',
    description TEXT NOT NULL,
    duration_min INT NOT NULL DEFAULT 0,
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
    doer_name_col VARCHAR(10) DEFAULT '',
    complete_col VARCHAR(10) DEFAULT '',
    header_map TEXT
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
    required TINYINT(1) DEFAULT 1,
    header_name VARCHAR(255) DEFAULT '',
    header_occ INT DEFAULT 0
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

  // ── Recruitment ────────────────────────────────────
  // The hiring pipeline: people being interviewed, not people employed. The
  // hr_employees table above is the other half — someone who joins moves from
  // here to there. Modelled on the same pipeline in the e-marketing project,
  // with one deliberate difference: that one reaches candidates over WhatsApp
  // and keys off a phone number, this one emails them, so email is the contact
  // that matters and phone is only kept for the record.
  ['hrm_candidates', `CREATE TABLE hrm_candidates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) DEFAULT '',
    profile_position VARCHAR(255) DEFAULT '',
    -- Who is taking the interview, typed in when the interview is booked.
    -- They get their own letter, with the candidate's phone and the notes.
    interviewer_email VARCHAR(255) DEFAULT '',
    interview_date DATE DEFAULT NULL,
    interview_time VARCHAR(20) DEFAULT '',
    status ENUM('Scheduled','Rescheduled','Selected','Onboarding','Rejected','Offer Sent') DEFAULT 'Scheduled',
    reschedule_date DATE DEFAULT NULL,
    reschedule_time VARCHAR(20) DEFAULT '',
    reschedule_reason TEXT,
    joining_date DATE DEFAULT NULL,
    salary VARCHAR(100) DEFAULT '',
    notes TEXT,
    created_by INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // Every mail the portal sends, and why it failed when it did. Mail goes
  // missing quietly — a wrong address, SMTP refusing, credentials expired — and
  // without a record the first anybody hears of it is a candidate who never
  // turned up.
  // What went on a candidate's offer letter. Kept because the letter is
  // regenerated on every send - a re-send after a typo has to produce the same
  // document, not today's guess at it - and because the last one answers what
  // the next one should start filled in with.
  //
  // The signatory is stored per offer rather than in a settings screen: it is
  // whoever signed that letter, which is a fact about the letter, and the form
  // pre-fills from the most recent one so nobody types it twice.
  ['hrm_offers', `CREATE TABLE hrm_offers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    candidate_id INT NOT NULL,
    department VARCHAR(255) DEFAULT '',
    location VARCHAR(255) DEFAULT '',
    offer_date DATE DEFAULT NULL,
    joining_date DATE DEFAULT NULL,
    valid_till DATE DEFAULT NULL,
    address1 VARCHAR(500) DEFAULT '',
    address2 VARCHAR(500) DEFAULT '',
    signatory_name VARCHAR(255) DEFAULT '',
    signatory_designation VARCHAR(255) DEFAULT '',
    signatory_email VARCHAR(255) DEFAULT '',
    signatory_phone VARCHAR(50) DEFAULT '',
    -- Who else was copied in. Kept so a re-send goes to the same people, and
    -- deliberately NOT inherited by the next candidate's letter: who sees an
    -- offer is a decision about that offer.
    cc_emails VARCHAR(1000) DEFAULT '',
    -- The letterhead the page is written under. Stored per offer so an old
    -- letter can be reproduced exactly, even after the office moves.
    company_name VARCHAR(255) DEFAULT '',
    company_address1 VARCHAR(500) DEFAULT '',
    company_address2 VARCHAR(500) DEFAULT '',
    sent_at TIMESTAMP NULL DEFAULT NULL,
    sent_by INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_hrm_offer_candidate (candidate_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // The documents themselves, bytes and all.
  //
  // They were on disk once, which is the better place for a file - until you
  // remember this deploys to Vercel, where the filesystem is read-only apart
  // from /tmp and /tmp does not survive the request that wrote it. A scan that
  // vanishes the moment the candidate submits it is worse than a fat row.
  //
  // Kept in their own table rather than as columns on hrm_joining_details, so
  // reading somebody's address does not drag a megabyte of PDF along with it.
  ['hrm_joining_files', `CREATE TABLE hrm_joining_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    candidate_id INT NOT NULL,
    -- resume_file, aadhaar_file, aadhaar_file_2, pan_file, pan_file_2
    field VARCHAR(32) NOT NULL,
    file_name VARCHAR(255) DEFAULT '',
    mime VARCHAR(100) DEFAULT '',
    bytes INT DEFAULT 0,
    content LONGBLOB,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- One document per slot: uploading again replaces it.
    UNIQUE KEY uniq_hrm_join_file (candidate_id, field)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // Influencers the marketing team is working with, and how far each one has
  // got: approved, messaged, shipped, received, posted.
  //
  // The client's team fills this in the app and the same row is written to
  // their Google Sheet, which is where they read it. sheet_row remembers which
  // line of that sheet a record owns, so an update rewrites its own line
  // rather than appending a second copy of the same influencer.
  //
  // The three dates arrive days apart - one on shipping, one when it lands,
  // one when the post goes up - so a row is created early and finished later.
  // That is why this is a record with edits, not a form that is submitted.
  // Bunai B2B - the wholesale order book, kept by hand. The online orders in
  // vin_orders come from Vinculum and nobody types them; these are the ones
  // sold party to party, so a person enters each and edits it as the money
  // arrives and the goods move.
  //
  // Money is DECIMAL, never FLOAT: a rupee that cannot be stored exactly is a
  // balance that never quite reaches zero.
  //
  // total_order_value is stored rather than always recomputed from pieces x
  // rate, because a negotiated price is a fact about the order that the two
  // multiplied together cannot express. balance_amount is stored for the same
  // reason the sheet has a column for it - it is written out to that sheet.
  ['b2b_orders', `CREATE TABLE b2b_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    party_name VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255) DEFAULT '',
    email VARCHAR(255) DEFAULT '',
    phone VARCHAR(50) DEFAULT '',
    city VARCHAR(160) DEFAULT '',
    what_was_sold VARCHAR(1000) DEFAULT '',
    pieces INT DEFAULT NULL,
    rate_per_piece DECIMAL(12,2) DEFAULT NULL,
    total_order_value DECIMAL(14,2) DEFAULT NULL,
    payment_status VARCHAR(20) DEFAULT '',
    amount_received DECIMAL(14,2) DEFAULT NULL,
    balance_amount DECIMAL(14,2) DEFAULT NULL,
    order_date DATE DEFAULT NULL,
    dispatch_date DATE DEFAULT NULL,
    delivery_date DATE DEFAULT NULL,
    order_status VARCHAR(20) DEFAULT '',
    remarks VARCHAR(1000) DEFAULT '',
    -- Which line of the Google Sheet this order owns, so an edit rewrites that
    -- line instead of leaving a second copy of the same order underneath.
    sheet_row INT DEFAULT NULL,
    created_by INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['influencers', `CREATE TABLE influencers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    profile_link VARCHAR(500) DEFAULT '',
    status VARCHAR(40) DEFAULT '',
    message_sent_on DATE DEFAULT NULL,
    collaboration_type VARCHAR(40) DEFAULT '',
    shipping_address VARCHAR(1000) DEFAULT '',
    email VARCHAR(255) DEFAULT '',
    phone VARCHAR(50) DEFAULT '',
    shipped_on DATE DEFAULT NULL,
    received_on DATE DEFAULT NULL,
    post_date DATE DEFAULT NULL,
    -- Which line of the Google Sheet this row owns. Null until the sheet is
    -- configured, or when a write to it failed - the record is kept either way.
    sheet_row INT DEFAULT NULL,
    created_by INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // What a selected candidate fills in before they join: who they are, who to
  // call if something happens, where they live, and the documents payroll and
  // the office need on day one. One row per candidate - the form can be sent
  // again and re-submitted, and the second answer replaces the first rather
  // than piling up beside it.
  //
  // The documents themselves are files on disk; only their names are here. A
  // scan of somebody's Aadhaar does not belong in a database row that gets
  // dumped into a backup by accident.
  ['hrm_joining_details', `CREATE TABLE hrm_joining_details (
    id INT AUTO_INCREMENT PRIMARY KEY,
    candidate_id INT NOT NULL,
    full_name VARCHAR(255) DEFAULT '',
    emp_mobile VARCHAR(20) DEFAULT '',
    email VARCHAR(255) DEFAULT '',
    dob DATE DEFAULT NULL,
    -- Two people to reach, and the relation is free text because the form's
    -- list has an "Other" the candidate types into (Uncle, Brother, ...).
    guardian1_name VARCHAR(255) DEFAULT '',
    guardian1_relation VARCHAR(100) DEFAULT '',
    guardian1_mobile VARCHAR(20) DEFAULT '',
    guardian2_name VARCHAR(255) DEFAULT '',
    guardian2_relation VARCHAR(100) DEFAULT '',
    guardian2_mobile VARCHAR(20) DEFAULT '',
    street VARCHAR(500) DEFAULT '',
    city VARCHAR(255) DEFAULT '',
    state VARCHAR(255) DEFAULT '',
    pincode VARCHAR(20) DEFAULT '',
    aadhaar_no VARCHAR(20) DEFAULT '',
    pan_no VARCHAR(20) DEFAULT '',
    -- Aadhaar and PAN are each one PDF or two photos, front and back.
    resume_file VARCHAR(255) DEFAULT '',
    aadhaar_file VARCHAR(255) DEFAULT '',
    aadhaar_file_2 VARCHAR(255) DEFAULT '',
    pan_file VARCHAR(255) DEFAULT '',
    pan_file_2 VARCHAR(255) DEFAULT '',
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_hrm_joining_candidate (candidate_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['hrm_message_log', `CREATE TABLE hrm_message_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    candidate_id INT DEFAULT NULL,
    candidate_name VARCHAR(255) DEFAULT '',
    email VARCHAR(255) DEFAULT '',
    action VARCHAR(255) DEFAULT '',
    subject VARCHAR(500) DEFAULT '',
    status ENUM('Sent','Failed') DEFAULT 'Failed',
    error_detail TEXT,
    retry_count INT DEFAULT 0,
    last_retry_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['leave_requests', `CREATE TABLE leave_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    leave_type ENUM('full_day','half_day','work_from_home','extra_working','early_leaving') NOT NULL,
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

  // ── INVENTORY — company equipment and who is holding it ──
  // Two tables, not one. The item is a thing the company owns and keeps owning;
  // an assignment is one spell of somebody holding it. Keeping the spells as
  // their own rows is what lets the register answer "who had this laptop last
  // year" — a `holder` column on the item would only ever know about today.
  ['inventory_items', `CREATE TABLE inventory_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(30) NOT NULL,
    brand VARCHAR(255) DEFAULT '',
    model VARCHAR(255) DEFAULT '',
    serial_number VARCHAR(255) DEFAULT '',
    photo LONGTEXT DEFAULT NULL,
    item_condition VARCHAR(20) DEFAULT 'good',
    status VARCHAR(20) DEFAULT 'available',
    notes TEXT,
    created_by INT DEFAULT NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // One spell of somebody holding an item. Closed by a return rather than
  // deleted, so the register keeps the history of who held what.
  ['inventory_assignments', `CREATE TABLE inventory_assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_id INT NOT NULL,
    user_id INT NOT NULL,
    assigned_by INT NOT NULL,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    returned_at DATETIME DEFAULT NULL,
    handover_status VARCHAR(20) DEFAULT 'active',
    handover_notes TEXT,
    return_reason VARCHAR(20) DEFAULT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // Vinculum's own words, kept verbatim, one row per order.
  //
  // This used to be a column on vin_orders itself, where it was 88% of the
  // table: 2.7 KB of JSON on every row, beside the dozen small columns the
  // Sales page actually reads. Every count, every revenue sum and every channel
  // breakdown dragged all of it through memory to reach an order_amount.
  //
  // It is read in exactly one place - the detail panel for a single order - so
  // it belongs where a single order can fetch it and nothing else has to step
  // over it. vin_orders drops from 23.5 MB to about 3 MB by moving it here.
  ['vin_orders_raw', `CREATE TABLE vin_orders_raw (
    order_id  VARCHAR(60) NOT NULL PRIMARY KEY,
    raw_json  LONGTEXT NULL,
    synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  // The same arrangement for returns, where the payload was 85% of the table.
  ['vin_returns_raw', `CREATE TABLE vin_returns_raw (
    return_no VARCHAR(60) NOT NULL PRIMARY KEY,
    raw_json  LONGTEXT NULL,
    synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],


  // ── Unicommerce (uni_*) ──
  // Yeh definitions sync scripts se hu-ba-hu hain. Dono jagah isliye hain
  // ki ims_* views in par bani hain aur views migration ke waqt banti hain —
  // us waqt tak sync chala ho, yeh zaroori nahi. Pehli deploy par table na
  // milne se view toot jaati thi aur page "not set up yet" dikhata tha,
  // jabki data mojood hota tha. Khaali table se view banti hai aur page
  // khaali dikhata hai — jo sach hai, aur galti nahi.
  ['uni_items', `CREATE TABLE uni_items (
      sku            VARCHAR(120) NOT NULL PRIMARY KEY,
      name           VARCHAR(500) NULL,
      category_code  VARCHAR(120) NULL,
      category_name  VARCHAR(255) NULL,
      brand          VARCHAR(120) NULL,
      color          VARCHAR(120) NULL,
      size           VARCHAR(60)  NULL,
      price          DECIMAL(12,2) NULL,
      base_price     DECIMAL(12,2) NULL,
      hsn_code       VARCHAR(40)  NULL,
      gst_tax_type   VARCHAR(40)  NULL,
      ean            VARCHAR(80)  NULL,
      weight         DECIMAL(12,3) NULL,
      enabled        TINYINT(1) NOT NULL DEFAULT 1,
      synced_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_uni_items_cat (category_code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_inventory', `CREATE TABLE uni_inventory (
      sku            VARCHAR(120) NOT NULL,
      facility       VARCHAR(80)  NOT NULL,
      inventory      INT NOT NULL DEFAULT 0,
      open_sale      INT NOT NULL DEFAULT 0,
      open_purchase  INT NOT NULL DEFAULT 0,
      blocked        INT NOT NULL DEFAULT 0,
      bad_inventory  INT NOT NULL DEFAULT 0,
      putaway_pending INT NOT NULL DEFAULT 0,
      pending_transfer INT NOT NULL DEFAULT 0,
      synced_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (sku, facility),
      KEY idx_uni_inv_qty (inventory),
      KEY idx_uni_inv_fac (facility)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_inventory_daily', `CREATE TABLE uni_inventory_daily (
      day        DATE NOT NULL,
      sku        VARCHAR(120) NOT NULL,
      facility   VARCHAR(80)  NOT NULL,
      inventory  INT NOT NULL DEFAULT 0,
      PRIMARY KEY (day, sku, facility),
      KEY idx_uni_invd_day (day)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_sync_log', `CREATE TABLE uni_sync_log (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      kind       VARCHAR(30) NOT NULL,
      started_at DATETIME NOT NULL,
      ended_at   DATETIME NULL,
      rows_seen  INT NOT NULL DEFAULT 0,
      ok         TINYINT(1) NOT NULL DEFAULT 0,
      error      TEXT NULL,
      KEY idx_uni_log_kind (kind, started_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_orders', `CREATE TABLE uni_orders (
      code              VARCHAR(120) NOT NULL PRIMARY KEY,
      display_code      VARCHAR(120) NULL,
      channel           VARCHAR(80)  NULL,
      source            VARCHAR(80)  NULL,
      status            VARCHAR(60)  NULL,
      order_category    VARCHAR(60)  NULL,
      order_date        DATETIME NULL,
      created_at_uni    DATETIME NULL,
      updated_at_uni    DATETIME NULL,
      fulfillment_tat   DATETIME NULL,
      cod               TINYINT(1) NOT NULL DEFAULT 0,
      currency          VARCHAR(10)  NULL,
      priority          VARCHAR(40)  NULL,
      customer_code     VARCHAR(120) NULL,
      customer_name     VARCHAR(255) NULL,
      customer_gstin    VARCHAR(40)  NULL,
      notification_email VARCHAR(255) NULL,
      notification_mobile VARCHAR(60) NULL,
      ship_address      VARCHAR(500) NULL,
      ship_city         VARCHAR(120) NULL,
      ship_state        VARCHAR(120) NULL,
      ship_pincode      VARCHAR(20)  NULL,
      ship_country      VARCHAR(80)  NULL,
      facility          VARCHAR(80)  NULL,
      item_count        INT NOT NULL DEFAULT 0,
      order_amount      DECIMAL(14,2) NULL,
      total_discount    DECIMAL(14,2) NULL,
      shipping_charges  DECIMAL(14,2) NULL,
      synced_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_uni_ord_date (order_date),
      KEY idx_uni_ord_status (status),
      KEY idx_uni_ord_channel (channel),
      KEY idx_uni_ord_facility (facility)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_order_items', `CREATE TABLE uni_order_items (
      code            VARCHAR(120) NOT NULL PRIMARY KEY,
      order_code      VARCHAR(120) NOT NULL,
      sku             VARCHAR(120) NULL,
      seller_sku      VARCHAR(120) NULL,
      item_name       VARCHAR(500) NULL,
      status          VARCHAR(60)  NULL,
      facility        VARCHAR(80)  NULL,
      selling_price   DECIMAL(12,2) NULL,
      total_price     DECIMAL(12,2) NULL,
      discount        DECIMAL(12,2) NULL,
      shipping_charges DECIMAL(12,2) NULL,
      max_retail_price DECIMAL(12,2) NULL,
      tax_percentage  DECIMAL(8,3) NULL,
      total_gst       DECIMAL(12,2) NULL,
      hsn_code        VARCHAR(40)  NULL,
      color           VARCHAR(120) NULL,
      size            VARCHAR(60)  NULL,
      brand           VARCHAR(120) NULL,
      shipping_package VARCHAR(120) NULL,
      cancellation_reason VARCHAR(255) NULL,
      created_at_uni  DATETIME NULL,
      updated_at_uni  DATETIME NULL,
      KEY idx_uni_oi_order (order_code),
      KEY idx_uni_oi_sku (sku),
      KEY idx_uni_oi_status (status)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_shipments', `CREATE TABLE uni_shipments (
      code             VARCHAR(120) NOT NULL PRIMARY KEY,
      order_code       VARCHAR(120) NOT NULL,
      channel_shipment VARCHAR(120) NULL,
      status           VARCHAR(60)  NULL,
      courier          VARCHAR(160) NULL,
      shipping_provider VARCHAR(160) NULL,
      shipping_method  VARCHAR(120) NULL,
      tracking_number  VARCHAR(160) NULL,
      tracking_status  VARCHAR(80)  NULL,
      courier_status   VARCHAR(120) NULL,
      invoice_code     VARCHAR(120) NULL,
      invoice_date     DATETIME NULL,
      dispatched_at    DATETIME NULL,
      delivered_at     DATETIME NULL,
      city             VARCHAR(120) NULL,
      no_of_items      INT NULL,
      collectable_amount DECIMAL(14,2) NULL,
      collected_amount DECIMAL(14,2) NULL,
      actual_weight    DECIMAL(12,3) NULL,
      created_at_uni   DATETIME NULL,
      updated_at_uni   DATETIME NULL,
      KEY idx_uni_shp_order (order_code),
      KEY idx_uni_shp_tracking (tracking_number),
      KEY idx_uni_shp_status (status)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_order_sync_log', `CREATE TABLE uni_order_sync_log (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      started_at  DATETIME NOT NULL,
      ended_at    DATETIME NULL,
      from_date   VARCHAR(40) NULL,
      to_date     VARCHAR(40) NULL,
      date_type   VARCHAR(20) NULL,
      orders_seen INT NOT NULL DEFAULT 0,
      ok          TINYINT(1) NOT NULL DEFAULT 0,
      error       TEXT NULL,
      KEY idx_uni_ols (started_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_returns', `CREATE TABLE uni_returns (
      code              VARCHAR(120) NOT NULL PRIMARY KEY,
      return_type       VARCHAR(20)  NULL,
      status            VARCHAR(60)  NULL,
      facility          VARCHAR(80)  NULL,
      order_code        VARCHAR(120) NULL,
      shipment_code     VARCHAR(120) NULL,
      reverse_pickup    VARCHAR(120) NULL,
      return_date       DATETIME NULL,
      channel_return_date DATETIME NULL,
      delivery_date     DATETIME NULL,
      received_date     DATETIME NULL,
      completed_date    DATETIME NULL,
      tracking_number   VARCHAR(160) NULL,
      courier           VARCHAR(160) NULL,
      shipping_provider VARCHAR(160) NULL,
      rto_tracking      VARCHAR(160) NULL,
      rto_courier       VARCHAR(160) NULL,
      rto_reason        VARCHAR(255) NULL,
      invoice_code      VARCHAR(120) NULL,
      putaway_code      VARCHAR(120) NULL,
      customer_name     VARCHAR(255) NULL,
      customer_phone    VARCHAR(60)  NULL,
      customer_city     VARCHAR(120) NULL,
      customer_state    VARCHAR(120) NULL,
      customer_pincode  VARCHAR(20)  NULL,
      -- Documented payload mein koi rakam nahi hai. Column rakha hai taaki
      -- jab source mile to bharne ke liye jagah ho; tab tak NULL.
      return_amount     DECIMAL(14,2) NULL,
      total_lines       INT NOT NULL DEFAULT 0,
      created_at_uni    DATETIME NULL,
      updated_at_uni    DATETIME NULL,
      synced_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_uni_ret_date (return_date),
      KEY idx_uni_ret_type (return_type),
      KEY idx_uni_ret_status (status),
      KEY idx_uni_ret_order (order_code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_return_items', `CREATE TABLE uni_return_items (
      return_code       VARCHAR(120) NOT NULL,
      sale_order_item   VARCHAR(120) NOT NULL,
      sku               VARCHAR(120) NULL,
      item_name         VARCHAR(500) NULL,
      item_status       VARCHAR(60)  NULL,
      order_code        VARCHAR(120) NULL,
      shipment_code     VARCHAR(120) NULL,
      facility          VARCHAR(80)  NULL,
      inventory_type    VARCHAR(60)  NULL,
      return_reason     VARCHAR(500) NULL,
      qc_comment        VARCHAR(500) NULL,
      remarks           VARCHAR(500) NULL,
      courier_status    VARCHAR(120) NULL,
      tracking_status   VARCHAR(120) NULL,
      PRIMARY KEY (return_code, sale_order_item),
      KEY idx_uni_ri_sku (sku),
      KEY idx_uni_ri_order (order_code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['uni_return_sync_log', `CREATE TABLE uni_return_sync_log (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      started_at   DATETIME NOT NULL,
      ended_at     DATETIME NULL,
      from_date    VARCHAR(40) NULL,
      to_date      VARCHAR(40) NULL,
      returns_seen INT NOT NULL DEFAULT 0,
      ok           TINYINT(1) NOT NULL DEFAULT 0,
      error        TEXT NULL,
      KEY idx_uni_rls (started_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];

// Columns added after a table first shipped. [table, column, DDL fragment]
// A database created from TABLES above already has all of them — the lookup in
// migrations.js skips every one of these on a modern schema.
const COLUMNS = [
  // hrm_candidates shipped without this one. CREATE TABLE IF NOT EXISTS no-ops
  // once the table is there, so a database that already has it would never get
  // the column and every insert would fail on an unknown field.
  ['hrm_candidates', 'interviewer_email', `VARCHAR(255) DEFAULT '' AFTER profile_position`],
  // The onboarding form is opened by somebody who has no login, so the link
  // itself is the credential: a long random string, one per candidate, good
  // only for their own form.
  ['hrm_candidates', 'joining_form_token', `VARCHAR(64) DEFAULT NULL`],
  ['hrm_candidates', 'joining_form_sent_at', `DATETIME DEFAULT NULL`],
  // hrm_offers existed before this column did, and CREATE TABLE IF NOT EXISTS
  // does nothing to a table that is already there.
  ['hrm_offers', 'cc_emails', `VARCHAR(1000) DEFAULT '' AFTER signatory_phone`],
  ['hrm_offers', 'company_name', `VARCHAR(255) DEFAULT '' AFTER cc_emails`],
  ['hrm_offers', 'company_address1', `VARCHAR(500) DEFAULT '' AFTER company_name`],
  ['hrm_offers', 'company_address2', `VARCHAR(500) DEFAULT '' AFTER company_address1`],

  ['users', 'notification_email', `VARCHAR(255) DEFAULT '' AFTER email`],
  // user_role — separate from app `role`. Decides leave-approval hierarchy
  // (e.g. an IT person may have app role 'admin' but user role 'user',
  // so their leave still goes to their HOD).
  ['users', 'user_role', `ENUM('admin','hod','pc','user') DEFAULT NULL AFTER role`],

  // Who leave requests go to. Before this the approver was "the department HOD,
  // else the lowest-id admin", which on a five-admin account meant one person
  // received everyone's leave whether or not that was anybody's intention.
  // Flagging people here makes the choice explicit and lets two share it.
  ['users', 'is_leave_approver', `TINYINT(1) NOT NULL DEFAULT 0 AFTER user_role`],
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
  // The header name each mapped column carried when the FMS was saved. Columns
  // move when someone inserts one in the sheet; the letter does not follow, the
  // name does. See services/fmsColumns.js.
  // Some sheets complete a step by ticking a checkbox and derive the actual
  // date from it themselves. Writing a timestamp into that derived column would
  // replace its formula, so the tick is what the app performs instead.
  ['fms_steps', 'complete_col', `VARCHAR(10) DEFAULT '' AFTER doer_name_col`],
  ['fms_steps', 'header_map', `TEXT AFTER doer_name_col`],
  ['fms_extra_rows', 'col_letter', `VARCHAR(10) DEFAULT '' AFTER row_label`],
  ['fms_extra_rows', 'field_type', `VARCHAR(20) DEFAULT 'text' AFTER col_letter`],
  ['fms_extra_rows', 'dropdown_options', `TEXT AFTER field_type`],
  // Required flag — default 1 so existing rows continue to be mandatory.
  ['fms_extra_rows', 'required', `TINYINT(1) DEFAULT 1 AFTER dropdown_options`],
  // On an extra row rather than in the step's header_map: saving an FMS deletes
  // and re-inserts these rows, so anything keyed by row id would go stale.
  ['fms_extra_rows', 'header_name', `VARCHAR(255) DEFAULT '' AFTER required`],
  ['fms_extra_rows', 'header_occ', `INT DEFAULT 0 AFTER header_name`],

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
  ['hrm_candidates', 'idx_hrm_status', 'status'],
  ['hrm_candidates', 'idx_hrm_interview', 'interview_date'],
  ['hrm_candidates', 'idx_hrm_join_token', 'joining_form_token'],
  // ── b2b_orders ──
  // The page filters by either status; the Sales roll-up sums a date window.
  ['b2b_orders', 'idx_b2b_order_status', 'order_status'],
  ['b2b_orders', 'idx_b2b_payment_status', 'payment_status'],
  ['b2b_orders', 'idx_b2b_order_date', 'order_date'],
  ['influencers', 'idx_influencer_status', 'status'],
  ['hrm_message_log', 'idx_hrm_msg_candidate', 'candidate_id'],
  ['hrm_message_log', 'idx_hrm_msg_status', 'status'],
  // ── hr_employees ──
  // Employee code is the human key — unique, but nullable (many NULLs allowed).
  ['hr_employees', 'uq_employee_code', 'employee_code', { unique: true }],
  // Link back to the login account, and the default list ordering.
  ['hr_employees', 'idx_user', 'user_id'],
  ['hr_employees', 'idx_status_name', 'employment_status, full_name'],

  // ── inventory ──
  // The grid filters on status and type; both assignment lookups are by item
  // or by person, and "what is still out" is a query on the spell's state.
  ['inventory_items', 'idx_inventory_status', 'status'],
  ['inventory_items', 'idx_inventory_type', 'type'],
  ['inventory_assignments', 'idx_inv_assign_item', 'item_id'],
  ['inventory_assignments', 'idx_inv_assign_user', 'user_id'],
  ['inventory_assignments', 'idx_inv_assign_status', 'handover_status'],

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

  // ── daily_tasks ──
  ['daily_tasks', 'idx_user_date', 'user_id, entry_date'],
  ['daily_tasks', 'idx_entry_date', 'entry_date'],
  // Client stats page aggregates by client_name (a string, not an FK).
  ['daily_tasks', 'idx_client_name', 'client_name(191)'],
  ['daily_tasks', 'idx_client_user', 'client_name(191), user_id'],

  // ── clients ──
  ['clients', 'idx_handler', 'handler_id'],
  ['clients', 'idx_active_name', 'is_active, name'],
];

// Data fixes that must run after the columns exist. Cheap and idempotent.
// Columns whose DEFINITION changed after they shipped — widening an ENUM, say.
// Adding a column is safe to fire blindly; changing one is not, so each entry
// carries the text that must already be in the live definition for it to be
// considered done. [table, column, new definition, marker]
const WIDENINGS = [
  // 'early_leaving' joined the list when short-notice early departures started
  // being requested through the app rather than over WhatsApp. Adding a value to
  // the end of an ENUM leaves every existing row exactly as it was.
  ['leave_requests', 'leave_type',
   `ENUM('full_day','half_day','work_from_home','extra_working','early_leaving') NOT NULL`,
   'early_leaving'],
  // 'Onboarding' is the stage between being chosen and being sent an offer:
  // the candidate has said yes, and their papers are being collected. It was
  // added after the fact, so existing rows keep whatever status they had.
  ['hrm_candidates', 'status',
   `ENUM('Scheduled','Rescheduled','Selected','Onboarding','Rejected','Offer Sent') DEFAULT 'Scheduled'`,
   'Onboarding'],
];

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

  // ── raw_json, out of the hot tables and into its own ──
  //
  // Copy first, and only let go of what is provably copied: the UPDATE below
  // joins the side table, so a row whose payload did not make it across keeps
  // the one it has. Both statements match nothing on the second run.
  //
  // Emptying the column does not shrink the file on disk - InnoDB keeps those
  // pages for reuse until someone runs OPTIMIZE TABLE - but it does stop them
  // being read into memory, which is the part that was costing anything.
  [`INSERT INTO vin_orders_raw (order_id, raw_json)
     SELECT o.order_id, o.raw_json FROM vin_orders o
      LEFT JOIN vin_orders_raw r ON r.order_id = o.order_id
      WHERE o.raw_json IS NOT NULL AND r.order_id IS NULL`,
   'move order payloads into vin_orders_raw'],
  [`INSERT INTO vin_returns_raw (return_no, raw_json)
     SELECT o.return_no, o.raw_json FROM vin_returns o
      LEFT JOIN vin_returns_raw r ON r.return_no = o.return_no
      WHERE o.raw_json IS NOT NULL AND r.return_no IS NULL`,
   'move return payloads into vin_returns_raw'],
  [`UPDATE vin_orders o JOIN vin_orders_raw r ON r.order_id = o.order_id
      SET o.raw_json = NULL WHERE o.raw_json IS NOT NULL`,
   'release order payloads from vin_orders'],
  [`UPDATE vin_returns o JOIN vin_returns_raw r ON r.return_no = o.return_no
      SET o.raw_json = NULL WHERE o.raw_json IS NOT NULL`,
   'release return payloads from vin_returns'],

  // ── ims_* views: one shape across the Vinculum → Unicommerce cutover ──
  //
  // The client moved to Unicommerce on 1 October 2026. The pages used to read
  // vin_* directly; pointing them at uni_* instead would have thrown away
  // everything before that date, and reading both in every route would have
  // put the migration into a dozen queries. These views carry the column names
  // the pages already use, so a route changes by one identifier.
  //
  // Stock is NOT a union. Stock means "right now", and right now lives only in
  // Unicommerce — vin_inventory is all zeros since inventory moved, and adding
  // it would contribute nothing but noise.
  [`CREATE OR REPLACE VIEW ims_inventory AS
      SELECT sku, facility AS warehouse, inventory AS qty, synced_at
        FROM uni_inventory`, 'view ims_inventory'],
  [`CREATE OR REPLACE VIEW ims_skus AS
      SELECT sku, name AS description, enabled AS is_active
        FROM uni_items`, 'view ims_skus'],
  // The pages ask for kind='inventory'; the Unicommerce sync logs it as
  // 'stock'. Renaming it here keeps that difference out of the routes.
  // Past-day stock. vin_inventory_daily holds exactly one day — the 3 October
  // run, all zeros, taken after inventory had already moved — so unioning it
  // would publish a day that misrepresents what was actually in the warehouse.
  // Same reasoning as ims_inventory: stock reads Unicommerce only.
  [`CREATE OR REPLACE VIEW ims_inventory_daily AS
      SELECT day, sku, facility AS warehouse, inventory AS qty
        FROM uni_inventory_daily`, 'view ims_inventory_daily'],
  [`CREATE OR REPLACE VIEW ims_sync_log AS
      SELECT id, CASE WHEN kind = 'stock' THEN 'inventory' ELSE kind END AS kind,
             started_at, ended_at, rows_seen, ok, error
        FROM uni_sync_log`, 'view ims_sync_log'],

  // Orders ARE a union, because the history matters — and it has to be
  // deduplicated. During the 1-3 October handover the same Myntra order was
  // pulled by both systems: Vin eRetail stores the channel's UUID in
  // ext_order_no, which is the very value Unicommerce uses as its own code.
  // 14 orders overlap that way. A plain UNION ALL would count them, and their
  // money, twice. Unicommerce wins, being the system that still gets updates.
  // The cutover date does the heavy lifting below. Unicommerce holds nothing
  // before it, so no earlier Vin eRetail order can be a duplicate and the
  // expensive check is skipped for all of them. Without that guard the
  // OR-across-two-columns lookup runs for every one of ~4,800 rows and cannot
  // use an index: the reorder query took 2.5s, against 114ms with it. The date
  // is read from the data, not written in, so it stays correct by itself.
  [`CREATE OR REPLACE VIEW ims_orders AS
      SELECT v.order_id, v.ext_order_no, v.order_date, v.status, v.channel_name,
             v.order_amount, v.payment_method, v.customer_name, v.customer_phone,
             v.ship_city, v.ship_state, 'vinculum' AS source
        FROM vin_orders v
       WHERE v.order_date < (SELECT MIN(order_date) FROM uni_orders)
          OR NOT EXISTS (SELECT 1 FROM uni_orders u
                          WHERE u.code = v.ext_order_no OR u.display_code = v.ext_order_no
                             OR u.code = v.order_id    OR u.display_code = v.order_id)
      UNION ALL
      SELECT u.code, u.display_code, u.order_date, u.status, u.channel,
             u.order_amount, CASE WHEN u.cod = 1 THEN 'COD' ELSE 'Prepaid' END,
             u.customer_name, u.notification_mobile, u.ship_city, u.ship_state,
             'unicommerce'
        FROM uni_orders u`, 'view ims_orders'],

  // Uniware has no quantity column: each saleOrderItem is one unit, so a
  // two-piece line is two rows. Hence the literal 1 — it is the honest
  // quantity, not a placeholder.
  [`CREATE OR REPLACE VIEW ims_order_items AS
      SELECT it.order_id, it.sku, it.sku_name, it.brand, it.status,
             it.order_qty, it.shipped_qty, it.cancelled_qty, it.return_qty,
             it.unit_price, it.discount_amt, it.tax_amount, 'vinculum' AS source
        FROM vin_order_items it
       WHERE NOT EXISTS (
               SELECT 1 FROM vin_orders v JOIN uni_orders u
                 ON u.code = v.ext_order_no OR u.display_code = v.ext_order_no
                    OR u.code = v.order_id OR u.display_code = v.order_id
                WHERE v.order_id = it.order_id
                  AND v.order_date >= (SELECT MIN(order_date) FROM uni_orders))
      UNION ALL
      SELECT it.order_code, it.sku, it.item_name, it.brand, it.status,
             1,
             CASE WHEN it.status IN ('DISPATCHED','DELIVERED','SHIPPED','COMPLETE') THEN 1 ELSE 0 END,
             CASE WHEN it.status = 'CANCELLED' THEN 1 ELSE 0 END,
             0,
             it.selling_price, it.discount, it.total_gst, 'unicommerce'
        FROM uni_order_items it`, 'view ims_order_items'],

  // The Sales page asks "how fresh is this?". Orders came from Vin eRetail
  // until 1 October and from Unicommerce after, so the honest answer is
  // whichever of the two ran last. The id offset only keeps the two id spaces
  // from colliding; nothing reads it.
  [`CREATE OR REPLACE VIEW ims_order_sync_log AS
      SELECT id, started_at, ended_at, orders_seen, ok FROM vin_order_sync_log
      UNION ALL
      SELECT id + 1000000, started_at, ended_at, orders_seen, ok
        FROM uni_order_sync_log`, 'view ims_order_sync_log'],
];

module.exports = { TABLES, COLUMNS, WIDENINGS, INDEXES, BACKFILLS };
