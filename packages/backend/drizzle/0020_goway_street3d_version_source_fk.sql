-- oxy:deploy-phase=pre
ALTER TABLE "street3d_scene_versions" ADD CONSTRAINT "street3d_versions_scene_source_fk" FOREIGN KEY ("scene_id","source") REFERENCES "public"."street3d_scenes"("id","source") ON DELETE no action ON UPDATE no action;
