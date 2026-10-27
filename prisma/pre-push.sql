-- Runs before `prisma db push` (npm run db:push and the migrate service), for changes db push can't make without
-- losing data, or refuses to make on a table that has rows. Every step checks first, so running it again, or on a
-- new database, does nothing.

-- October 2026: class_sections.shift (MORNING / AFTERNOON, NULL = full day) becomes class_sections.schedule
-- (FULL_DAY / MORNING / AFTERNOON). Values are copied before the old column goes; its unique index goes with it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'class_sections' AND column_name = 'shift'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ClassSchedule') THEN
      CREATE TYPE "ClassSchedule" AS ENUM ('FULL_DAY', 'MORNING', 'AFTERNOON');
    END IF;
    ALTER TABLE class_sections ADD COLUMN IF NOT EXISTS schedule "ClassSchedule" NOT NULL DEFAULT 'FULL_DAY';
    UPDATE class_sections SET schedule = shift::text::"ClassSchedule" WHERE shift IS NOT NULL;
    ALTER TABLE class_sections DROP COLUMN shift;
  END IF;
END $$;

-- The new unique index (one class per room, schedule and year), created here because db push won't add it to a
-- table with rows. The old rule couldn't see full-day classes (their shift was NULL), so two of them may share a
-- room: all but the first lose the room, and each is reported, so someone can give it another.
DO $$
DECLARE
  clash RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'class_sections' AND column_name = 'schedule'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'class_sections_room_id_schedule_academic_year_id_key'
  ) THEN
    FOR clash IN
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY room_id, schedule, academic_year_id ORDER BY section_name, id) AS n
        FROM class_sections WHERE room_id IS NOT NULL
      ) ranked WHERE n > 1
    LOOP
      RAISE NOTICE 'Class section % shared its room with a class of the same schedule; its room was cleared', clash.id;
      UPDATE class_sections SET room_id = NULL WHERE id = clash.id;
    END LOOP;
    CREATE UNIQUE INDEX class_sections_room_id_schedule_academic_year_id_key
      ON class_sections (room_id, schedule, academic_year_id);
  END IF;
END $$;
