-- Admin feedback loop: free-text feedback stored on the article and consumed
-- by the next editor pass (the runner clears it after one revision).
-- The pipeline also gains an 'image' stage (assemble → image → publish);
-- stage is TEXT so no schema change is needed for that.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS feedback TEXT;
