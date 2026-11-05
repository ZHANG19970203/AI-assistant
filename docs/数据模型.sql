-- 《人体运动学》生产数据模型参考，2026-10-28。
-- 不是当前 SQLite 原型的迁移；未在 PostgreSQL 实例执行或验收。
-- 先评估既有 Python/SQLite 实验室后台，优先适配/增量迁移，避免重复建设。
-- 需要 PostgreSQL 15+、pgcrypto、pgvector。扩展与迁移使用独立高权限账号。
-- API/worker 使用非表所有者的最小权限角色；禁止将数据库直连交给客户端或模型。
-- 当前用户由验证后的服务端会话用 SET LOCAL app.user_id 设置。
-- 自定义 GUC 不是认证系统：能执行任意 SQL 的角色可修改它，必须禁止非受信直连。

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS companion;
CREATE SCHEMA IF NOT EXISTS teacher_exam;

CREATE TABLE companion.institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE companion.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES companion.institutions,
  display_name text NOT NULL,
  internal_student_ref text, -- 最小化内部编号；真实学号映射可另存受限表
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 此表不授予学生/普通教师查询权限；openid需应用加密/密钥管理与最小使用。
CREATE TABLE companion.wechat_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES companion.users,
  app_id text NOT NULL,
  openid_ciphertext bytea NOT NULL,
  openid_lookup_hmac bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(app_id, openid_lookup_hmac), UNIQUE(app_id,user_id)
  -- 不持久化客户端可读的 session_key；AppSecret/token 使用服务端秘密管理。
);
CREATE TABLE companion.courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES companion.institutions,
  code text NOT NULL,
  title text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 3650), -- 由机构明确填写
  UNIQUE(institution_id,code)
);
CREATE TABLE companion.course_memberships (
  course_id uuid NOT NULL REFERENCES companion.courses,
  user_id uuid NOT NULL REFERENCES companion.users,
  role text NOT NULL CHECK(role IN ('student','teacher','course_admin')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(course_id,user_id)
  -- API须校验用户与课程机构一致；生产迁移可再加机构复合外键。
);
CREATE TABLE companion.classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES companion.courses,
  title text NOT NULL,
  cohort_type text NOT NULL, -- 普通本科/专升本，不混用日历
  timetable_version text NOT NULL,
  UNIQUE(id,course_id)
);
CREATE TABLE companion.class_enrollments (
  class_id uuid NOT NULL,
  course_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY(class_id,user_id),
  FOREIGN KEY(class_id,course_id) REFERENCES companion.classes(id,course_id),
  FOREIGN KEY(course_id,user_id) REFERENCES companion.course_memberships(course_id,user_id)
);
CREATE TABLE companion.chapters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES companion.courses,
  title text NOT NULL,
  position integer NOT NULL,
  learning_objectives jsonb NOT NULL DEFAULT '[]',
  UNIQUE(id,course_id)
);
CREATE TABLE companion.lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  class_id uuid NOT NULL,
  chapter_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','cancelled')),
  UNIQUE(id,course_id,class_id),
  CHECK(ends_at>starts_at),
  FOREIGN KEY(class_id,course_id) REFERENCES companion.classes(id,course_id),
  FOREIGN KEY(chapter_id,course_id) REFERENCES companion.chapters(id,course_id)
);

CREATE TABLE companion.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES companion.courses,
  chapter_id uuid,
  title text NOT NULL,
  source_type text NOT NULL CHECK(source_type IN ('course','teacher_exam','research')),
  audience text NOT NULL CHECK(audience IN ('student','teacher')),
  copyright_basis text NOT NULL,
  created_by uuid NOT NULL REFERENCES companion.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,course_id),
  CHECK(source_type='course' OR audience='teacher'),
  FOREIGN KEY(chapter_id,course_id) REFERENCES companion.chapters(id,course_id)
);
CREATE TABLE companion.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_label text NOT NULL,
  object_key text NOT NULL, -- 私有对象key，不能直接作为公共URL
  sha256 text NOT NULL CHECK(length(sha256)=64),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','revoked','rejected')),
  parser_version text NOT NULL,
  page_map jsonb NOT NULL DEFAULT '{}', -- 文件页/印刷页/幻灯片页/图像定位
  approved_by uuid REFERENCES companion.users,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,version_label), UNIQUE(id,course_id),
  FOREIGN KEY(document_id,course_id) REFERENCES companion.documents(id,course_id),
  CHECK(status<>'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
  -- 版本内容不可原位覆盖；修订创建新版本，审批 API 必须限制教师角色。
);
CREATE TABLE companion.chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  section text NOT NULL,
  file_page integer CHECK(file_page>0),
  printed_page text,
  slide_no integer CHECK(slide_no>0),
  content text NOT NULL,
  content_hash text NOT NULL,
  embedding vector, -- 选定供应商后固定维度并为同一模型版本建立索引；不可混用
  embedding_provider text,
  embedding_model_version text,
  UNIQUE(document_version_id,ordinal), UNIQUE(id,course_id),
  FOREIGN KEY(document_version_id,course_id) REFERENCES companion.document_versions(id,course_id),
  CHECK(embedding IS NULL OR (embedding_provider IS NOT NULL AND embedding_model_version IS NOT NULL))
);
CREATE INDEX chunks_scope_idx ON companion.chunks(course_id,document_version_id);
-- 中文词法检索应选经验证的分词/检索方案；不假定 PostgreSQL 默认英文分词适合中文。
-- 向量维度/模型确认后建立相应表达式 HNSW/IVFFlat 索引，生产前用真实数据评测。

CREATE TABLE companion.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  class_id uuid NOT NULL,
  lesson_id uuid,
  phase text NOT NULL CHECK(phase IN ('pre','in','post')),
  title text NOT NULL,
  description text NOT NULL,
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  schedule_version integer NOT NULL DEFAULT 1 CHECK(schedule_version>0),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','cancelled')),
  created_by uuid NOT NULL REFERENCES companion.users,
  UNIQUE(id,course_id,class_id),
  CHECK(expires_at>=due_at),
  FOREIGN KEY(class_id,course_id) REFERENCES companion.classes(id,course_id),
  FOREIGN KEY(lesson_id,course_id,class_id) REFERENCES companion.lessons(id,course_id,class_id)
);
CREATE TABLE companion.task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  course_id uuid NOT NULL,
  class_id uuid NOT NULL,
  student_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','excused')),
  completed_at timestamptz,
  reflection text,
  confidence smallint CHECK(confidence BETWEEN 1 AND 5), -- 学生自评，非推断掌握度
  UNIQUE(task_id,student_id), UNIQUE(id,course_id),
  FOREIGN KEY(task_id,course_id,class_id) REFERENCES companion.tasks(id,course_id,class_id),
  FOREIGN KEY(class_id,student_id) REFERENCES companion.class_enrollments(class_id,user_id),
  CHECK(status<>'completed' OR completed_at IS NOT NULL)
);
CREATE TABLE companion.learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES companion.courses,
  actor_user_id uuid NOT NULL REFERENCES companion.users,
  assignment_id uuid,
  event_type text NOT NULL,
  source text NOT NULL CHECK(source IN ('miniapp','web','lab','teacher')),
  client_event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}',
  UNIQUE(source,actor_user_id,client_event_id),
  FOREIGN KEY(assignment_id,course_id) REFERENCES companion.task_assignments(id,course_id)
  -- payload 使用事件白名单，禁止密钥/医学隐私/全量点击轨迹，限制字段与长度。
  -- 现有实验室事件需适配并确认真实身份；浏览页面不能自动标记实验完成。
);
CREATE TABLE companion.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES companion.courses,
  student_id uuid NOT NULL REFERENCES companion.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,course_id)
);
CREATE TABLE companion.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  course_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('student','assistant','teacher')),
  content text NOT NULL,
  provider text,
  model_version text,
  retrieval_version text,
  abstained boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,course_id),
  FOREIGN KEY(conversation_id,course_id) REFERENCES companion.conversations(id,course_id)
);
CREATE TABLE companion.citations (
  message_id uuid NOT NULL,
  course_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  evidence_excerpt text NOT NULL,
  PRIMARY KEY(message_id,chunk_id),
  FOREIGN KEY(message_id,course_id) REFERENCES companion.messages(id,course_id),
  FOREIGN KEY(chunk_id,course_id) REFERENCES companion.chunks(id,course_id)
  -- 服务端在写入前确认chunk属于本次授权检索集合；版本由chunk关联不可变version。
);
CREATE TABLE companion.teacher_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES companion.courses,
  student_id uuid NOT NULL REFERENCES companion.users,
  conversation_id uuid,
  question text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','answered','closed')),
  teacher_id uuid REFERENCES companion.users,
  teacher_reply text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(conversation_id,course_id) REFERENCES companion.conversations(id,course_id)
);

-- 六维反馈扩展：学习作品是候选证据，不自动生成能力分。
CREATE TABLE companion.dimension_rubrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES companion.courses,
  dimension_id text NOT NULL CHECK(dimension_id IN ('concept','observation','evidence','transfer','reflection','planning')),
  version_label text NOT NULL,
  criteria jsonb NOT NULL CHECK(jsonb_typeof(criteria)='array' AND jsonb_array_length(criteria)=5), -- 0..4级公开标准
  approved_by uuid NOT NULL REFERENCES companion.users,
  approved_at timestamptz NOT NULL,
  UNIQUE(course_id,dimension_id,version_label), UNIQUE(id,course_id,dimension_id)
);
CREATE TABLE companion.learning_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES companion.courses,
  chapter_id uuid,
  student_id uuid NOT NULL REFERENCES companion.users,
  kind text NOT NULL CHECK(kind IN ('task_reflection','practice_attempt','note','observation_work','transfer_work','plan_review')),
  source_record_id text NOT NULL,
  work_snapshot text NOT NULL,
  source_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,course_id,student_id),
  FOREIGN KEY(chapter_id,course_id) REFERENCES companion.chapters(id,course_id)
  -- API验证源作品确实属于本人/课程；学生笔记及AI练习结果均需教师核对才能评分。
);
CREATE TABLE companion.teacher_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  chapter_id uuid NOT NULL,
  student_id uuid NOT NULL,
  dimension_id text NOT NULL CHECK(dimension_id IN ('concept','observation','evidence','transfer','reflection','planning')),
  rubric_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  score smallint NOT NULL CHECK(score BETWEEN 0 AND 4),
  teacher_id uuid NOT NULL REFERENCES companion.users,
  reason text NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid REFERENCES companion.teacher_assessments,
  FOREIGN KEY(chapter_id,course_id) REFERENCES companion.chapters(id,course_id),
  FOREIGN KEY(rubric_id,course_id,dimension_id) REFERENCES companion.dimension_rubrics(id,course_id,dimension_id),
  FOREIGN KEY(evidence_id,course_id,student_id) REFERENCES companion.learning_evidence(id,course_id,student_id)
  -- 无评分记录时用LEFT JOIN返回null，不能COALESCE为0或自动填图。
  -- 服务端验证teacher_id为当前有权限教师、证据已核对、章节一致；不可接受客户端自报教师身份。
  -- 修订写入新记录，保留标准版本/理由/作品及更正轨迹；练习正确率另表独立统计。
);
ALTER TABLE companion.learning_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.learning_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE companion.teacher_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.teacher_assessments FORCE ROW LEVEL SECURITY;
-- 这些表同样默认无运行GRANT/无策略，生产按本人读取/负责课程教师评分补齐并验收。

CREATE TABLE companion.reminder_preferences (
  user_id uuid PRIMARY KEY REFERENCES companion.users,
  enabled boolean NOT NULL DEFAULT false,
  quiet_start time NOT NULL DEFAULT '22:00',
  quiet_end time NOT NULL DEFAULT '08:00',
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE companion.subscription_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES companion.users,
  app_id text NOT NULL,
  template_id text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('once','long_term')),
  status text NOT NULL CHECK(status IN ('unverified','accepted','rejected','revoked','banned')),
  verified_at timestamptz,
  revoked_at timestamptz,
  remaining_count integer NOT NULL DEFAULT 0 CHECK(remaining_count>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,app_id,template_id)
  -- 保守的本地台账；不是微信承诺无限额度。平台事件和发送结果需核对/幂等处理。
);
CREATE TABLE companion.wechat_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL,
  deduplication_key text NOT NULL,
  event_type text NOT NULL,
  verified_signature boolean NOT NULL CHECK(verified_signature),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  minimal_payload jsonb NOT NULL,
  UNIQUE(app_id,deduplication_key)
  -- 验签、解密、回放时间窗在服务层；对官方可能的对象/数组List格式兼容。
);
CREATE TABLE companion.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES companion.users,
  consent_id uuid NOT NULL REFERENCES companion.subscription_consents,
  channel text NOT NULL CHECK(channel='wechat_subscription'),
  template_id text NOT NULL,
  schedule_version integer NOT NULL,
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','retry','sent','failed','cancelled','unknown')),
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at timestamptz,
  provider_message_id text,
  last_error_code text,
  UNIQUE(assignment_id,user_id,template_id,schedule_version),
  FOREIGN KEY(assignment_id,course_id) REFERENCES companion.task_assignments(id,course_id),
  CHECK(expires_at>=due_at)
  -- worker领取用事务/锁，发送前再次检查身份一致/授权/额度/撤回/安静时段/任务状态。
  -- 未知外部结果标记unknown，不能无条件重发；本地唯一键不等于外部精确一次。
);
CREATE INDEX outbox_due_idx ON companion.outbox(next_attempt_at,due_at) WHERE status IN ('pending','retry');
CREATE TABLE companion.delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES companion.outbox,
  attempt_no integer NOT NULL CHECK(attempt_no>0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result text NOT NULL CHECK(result IN ('started','accepted','confirmed','rejected','unknown')),
  provider_code text,
  provider_message_id text,
  UNIQUE(outbox_id,attempt_no)
);
CREATE TABLE companion.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES companion.courses,
  actor_user_id uuid REFERENCES companion.users,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  minimal_change jsonb NOT NULL DEFAULT '{}'
  -- 审计避免存整份私密内容、密钥和真实健康信息；保留/删除按机构规则执行。
);

-- 教师考试资料物理逻辑隔离：学生检索角色对schema无USAGE，对表无任何权限。
CREATE TABLE teacher_exam.items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES companion.courses,
  source_version text NOT NULL,
  stem text NOT NULL,
  answer_key jsonb NOT NULL,
  rubric jsonb NOT NULL DEFAULT '{}',
  allowed_use text NOT NULL CHECK(allowed_use IN ('teacher_only','exam')),
  created_by uuid NOT NULL REFERENCES companion.users
);
REVOKE ALL ON SCHEMA teacher_exam FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA teacher_exam FROM PUBLIC;
ALTER TABLE teacher_exam.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_exam.items FORCE ROW LEVEL SECURITY;
-- 该表无学生策略；教师阅卷服务另建最小权限策略与专用角色。

-- RLS参考：API用服务端会话设置用户，事务结束自动释放。
CREATE FUNCTION companion.actor_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog
AS $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
-- 由迁移所有者创建；固定搜索路径，避免策略查询memberships导致递归。
CREATE FUNCTION companion.has_course_role(p_course uuid,p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,companion
AS $$ SELECT EXISTS(SELECT 1 FROM companion.course_memberships m
  WHERE m.course_id=p_course AND m.user_id=companion.actor_id() AND m.active AND m.role=ANY(p_roles)) $$;
REVOKE ALL ON FUNCTION companion.has_course_role(uuid,text[]) FROM PUBLIC;
-- 部署时仅向受信API运行角色授予上面函数EXECUTE；函数所有者须能查询membership。

ALTER TABLE companion.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY document_read ON companion.documents FOR SELECT USING (
  companion.has_course_role(course_id,ARRAY['teacher','course_admin'])
  OR (source_type='course' AND audience='student'
      AND companion.has_course_role(course_id,ARRAY['student']))
);
ALTER TABLE companion.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY version_read ON companion.document_versions FOR SELECT USING (
  companion.has_course_role(course_id,ARRAY['teacher','course_admin'])
  OR (status='approved' AND EXISTS(SELECT 1 FROM companion.documents d
      WHERE d.id=document_id AND d.course_id=document_versions.course_id
      AND d.source_type='course' AND d.audience='student'))
);
ALTER TABLE companion.chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY chunk_read ON companion.chunks FOR SELECT USING (
  companion.has_course_role(course_id,ARRAY['teacher','course_admin'])
  OR EXISTS(SELECT 1 FROM companion.document_versions v
    JOIN companion.documents d ON d.id=v.document_id AND d.course_id=v.course_id
    WHERE v.id=document_version_id AND v.course_id=chunks.course_id
      AND v.status='approved' AND d.source_type='course' AND d.audience='student'
      AND companion.has_course_role(v.course_id,ARRAY['student']))
);
CREATE VIEW companion.student_search_chunks WITH (security_invoker=true) AS
SELECT c.* FROM companion.chunks c
JOIN companion.document_versions v ON v.id=c.document_version_id AND v.course_id=c.course_id
JOIN companion.documents d ON d.id=v.document_id AND d.course_id=v.course_id
WHERE v.status='approved' AND d.source_type='course' AND d.audience='student';

ALTER TABLE companion.task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.task_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_read ON companion.task_assignments FOR SELECT USING (
  student_id=companion.actor_id()
  OR companion.has_course_role(course_id,ARRAY['teacher','course_admin'])
);
ALTER TABLE companion.learning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.learning_events FORCE ROW LEVEL SECURITY;
CREATE POLICY event_read ON companion.learning_events FOR SELECT USING (
  actor_user_id=companion.actor_id()
  OR companion.has_course_role(course_id,ARRAY['teacher','course_admin'])
);
ALTER TABLE companion.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_read ON companion.conversations FOR SELECT USING (
  student_id=companion.actor_id()
  OR companion.has_course_role(course_id,ARRAY['teacher','course_admin'])
);
ALTER TABLE companion.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY message_read ON companion.messages FOR SELECT USING (
  EXISTS(SELECT 1 FROM companion.conversations c WHERE c.id=conversation_id AND c.course_id=messages.course_id)
);
ALTER TABLE companion.citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion.citations FORCE ROW LEVEL SECURITY;
CREATE POLICY citation_read ON companion.citations FOR SELECT USING (
  EXISTS(SELECT 1 FROM companion.messages m WHERE m.id=message_id AND m.course_id=citations.course_id)
);

-- 此文件未对其它表授予运行权限，缺少的权限均默认拒绝。
-- 正式迁移必须补全每个API/worker的最小GRANT、写入策略/事务或受限存储过程。
-- 禁止直接给所有运行角色 GRANT ALL ON ALL TABLES，也不能用数据库owner运行API。
-- 索引、RLS性能、审批状态迁移、跨机构一致性、删除/留存与备份策略仍需生产验收。
