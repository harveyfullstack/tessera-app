-- Latest-attempt status needs the time a running attempt started so a worker
-- that never finishes can be told apart from one that is still inside the window.

ALTER TABLE delivery_attempts
  ADD COLUMN started_at TIMESTAMPTZ;
