-- Feedback round 2: team payments recorded BEFORE the auto-expense feature
-- shipped have no linked expense, so they never appeared in project or
-- general expenses. Backfill one expense per orphaned person payment,
-- mirroring exactly what createPersonPayment does for new payments.

INSERT INTO expenses (date, category_id, description, project_id, supplier, amount_minor, currency, fx_rate_micro, person_payment_id)
SELECT
  pp.date,
  COALESCE(
    (SELECT id FROM expense_categories
     WHERE name_en = CASE pe.type WHEN 'EMPLOYEE' THEN 'Salaries' ELSE 'Freelancers' END
     ORDER BY id LIMIT 1),
    (SELECT id FROM expense_categories ORDER BY sort_order, id LIMIT 1)
  ),
  CASE WHEN pp.note IS NOT NULL AND pp.note != '' THEN pe.name || ' — ' || pp.note ELSE pe.name END,
  a.project_id,
  pe.name,
  pp.amount_minor,
  a.currency,
  a.fx_rate_micro,
  pp.id
FROM person_payments pp
JOIN project_assignments a ON a.id = pp.assignment_id
JOIN people pe ON pe.id = a.person_id
WHERE NOT EXISTS (SELECT 1 FROM expenses e WHERE e.person_payment_id = pp.id);
