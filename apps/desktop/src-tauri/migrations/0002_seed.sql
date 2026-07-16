-- Default settings, currencies and the twelve standard expense categories.

INSERT INTO settings (key, value) VALUES
  ('language', 'ar'),
  ('theme', 'light'),
  ('project_code_prefix', 'PRJ'),
  ('last_auto_backup_date', '');

INSERT INTO currencies (code, fx_rate_micro) VALUES
  ('EGP', 1000000),
  ('USD', 48500000),
  ('EUR', 52500000),
  ('GBP', 61500000),
  ('SAR', 12900000),
  ('AED', 13200000),
  ('QAR', 13300000),
  ('KWD', 158000000),
  ('BHD', 128500000),
  ('OMR', 126000000),
  ('JOD', 68400000);

INSERT INTO expense_categories (name_en, name_ar, sort_order) VALUES
  ('Salaries', 'رواتب', 1),
  ('Freelancers', 'مستقلون', 2),
  ('Travel', 'سفر', 3),
  ('Transportation', 'انتقالات', 4),
  ('Printing', 'طباعة', 5),
  ('Office Rent', 'إيجار المكتب', 6),
  ('Software', 'برامج واشتراكات', 7),
  ('Equipment', 'معدات وأجهزة', 8),
  ('Internet', 'إنترنت واتصالات', 9),
  ('Site Visits', 'زيارات الموقع', 10),
  ('Utilities', 'مرافق', 11),
  ('Miscellaneous', 'متنوعة', 12);
