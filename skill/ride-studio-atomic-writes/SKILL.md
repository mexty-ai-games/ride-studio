---
name: ride-studio-atomic-writes
description: Build Mexty and EdVerse content on camera for Ride Studio — every write is one small visible change, in an order a viewer can follow. Use for any Ride Studio worker task.
---

# Ride Studio: you are building on camera

A phone is filming the Mexty viewer while you work. Each MCP write you make appears on screen the moment it lands, and it is recorded. The audience should be able to follow the content growing piece by piece, so how you sequence the work matters as much as the result.

## One visible change per call

- Make one MCP call per visible change. Create the slide, then set its title, then add each element (paragraph, bullet, image, question) in its own call. The viewer sees the title type in, then each bullet arrive.
- Never build a whole course, evaluation or learning path in a single call. The bulk tools (`add_bulk_slides`, `add_program_nodes_bulk`, `add_evaluation_steps_bulk`, `add_program_links_bulk`) are for off-screen work only: use them only when the brief says the content is not being shown.
- For EdVerse scenes, use small `edit_scene` steps: one object, one material or one move per call. This is also the team rule.
- Create the container first (`create_course`, `create_program`, `create_evaluation`, `create_game`) with its real title, so the preview can open on it, then fill it.

## An order the viewer can follow

- Finish one slide before starting the next. Do not jump back and forth between slides.
- Work top to bottom: title, then content in reading order. For a learning path: nodes in order, then the links between them. For an evaluation: one question at a time, complete with its answers.
- Do reads and planning before the first write, so the writes then arrive at a steady pace without long gaps.
- When asked to change existing content ("make the quiz harder"), edit in place with the smallest set of updates. Do not delete and rebuild.

## Content

- Write real, specific content for the company and audience in the brief, in French unless the brief says otherwise. No placeholder text, since it would be on camera.
- Keep slides short: a title and two to four elements. Favour concrete situations from the learner's job.
- Follow Mexty's own rules for each content type (blocks need saved props, check ownership before reusing a store block or template, never invent ids).

## Limits

- Use only the MEXTY and EDVERSE MCP tools. Do not touch the filesystem, the shell or the web.
- Do not call media generation tools (`generate_image`, `generate_audio`, `generate_3d_model_*`) unless the brief asks: they spend Mexty credits. Prefer `search_media` and existing assets.
- Do not publish, schedule, share or delete anything unless the brief asks for it.
- When you are done, reply with two sentences: what now exists and anything the rider should know. That summary is read aloud.
