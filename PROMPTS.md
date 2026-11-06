# PROMPTS.md: Chronological AI Tool Prompt Log

This document records the exact, unedited sequence of prompts submitted to AI tools during the 24-hour hackathon, in accordance with Section 9 of the problem statement.

---

### Entry 1
- **Tool**: Google Antigravity / Gemini 3.8 Flash
- **Timestamp**: 2026-11-06T11:48:26+05:30
- **Prompt**:
```text
I have provided you with a PDF named "Kill It and Prove It.pdf". This PDF contains the complete problem statement and requirements for our 24-hour engineering hackathon.

Your task is to carefully read and understand the ENTIRE PDF (all 19 pages) before starting development.

1. Understand the problem

We need to build a key-value database from scratch that can survive unexpected process crashes at any moment.

This is NOT a normal application. The main focus is:

- Data durability
- Crash recovery
- Atomic batch operations
- Concurrent access
- Disk-full handling
- Crash-safe compaction
- Testing and verification

2. First analyse the requirements

Before writing code:

- Explain the problem statement in simple words.
- Identify all mandatory features.
- Identify all judging criteria.
- Suggest the best programming language and architecture.
- Explain the proposed database storage format.
- Explain how crash recovery will work.
- Explain how we can satisfy every requirement.

Do not skip any requirement from the PDF.

3. Build the database engine

Implement all mandatory operations:

- put(key, value)
- get(key)
- delete(key)
- batch(operations)
- open(path)
- close()

Requirements:

- Use a crash-safe storage mechanism.
- Ensure acknowledged writes survive process termination.
- Ensure batches are fully applied or completely absent.
- Support at least 1 million keys.
- Support values up to 1 MB.
- Support batches up to 10,000 operations.
- Support concurrent writers and readers.
- Implement crash-safe compaction.
- Implement configurable maximum file size.
- Ensure recovery completes within 2 seconds for 1 million keys.

4. Build the command-line interface

Implement all eight commands specified in the PDF:

1. open
2. put
3. get
4. del
5. batch
6. dump
7. check
8. serve

Follow the exact expected behaviour and output requirements.

In serve mode, print ACK only after the operation is safely persisted to disk.

5. Build the torture testing tool

Create an independent torture testing tool.

It must:

- Start the database as a child process.
- Generate random puts, deletes and batches.
- Support at least two concurrent writers.
- Maintain an independent oracle recording acknowledged operations.
- Randomly kill the database process without graceful shutdown.
- Restart and verify database consistency.
- Detect missing acknowledged operations and partially applied batches.
- Support reproducible random seeds.
- Run 500 iterations by default.

Include all targeted testing modes mentioned in the PDF:

- Large values
- Large batches
- Recovery crashes
- Compaction crashes
- Disk-full testing

6. Create all required documentation

Generate the following files:

- README.md
- ARCHITECTURE.md
- BREAKING.md
- PROMPTS.md

Also create the architecture diagram inside a diagrams folder.

ARCHITECTURE.md must contain:

- Complete architecture diagram.
- On-disk file format.
- Write ordering.
- Recovery process.
- Scenario-to-mechanism proof table covering every scenario A1 to F4 specified in the PDF.
- Three guarantees: durability, atomicity and recoverability.

BREAKING.md must include:

- Crash points table.
- Ordering argument.
- At least three known weaknesses.
- Failed approaches and discovered bugs.
- Improvements possible with 24 additional hours.

README.md must explain how to build and execute every command.

7. Important restrictions

Strictly follow the hackathon rules:

- Do not use SQLite, RocksDB, LevelDB or any other database/storage engine.
- Do not use ORM or persistence libraries.
- Do not copy code from existing database projects.
- Use only permitted standard libraries and tools.
- Ensure the project works offline.
- Maintain meaningful Git commits throughout development.

8. Development approach

Work in small, understandable stages:

Stage 1: Analyse the PDF and propose architecture.

Stage 2: Create the project folder structure.

Stage 3: Implement the basic database engine.

Stage 4: Implement crash recovery and durability.

Stage 5: Implement atomic batches and concurrency.

Stage 6: Implement compaction and disk-full handling.

Stage 7: Implement the CLI.

Stage 8: Implement the torture testing tool.

Stage 9: Run tests, identify bugs and fix them.

Stage 10: Complete all documentation.

Stage 11: Perform a final verification against every requirement in the PDF.

9. Very important instructions

- Do not simply generate code and claim it works.
- Actually build and run the project.
- Test every feature.
- Fix compilation errors and runtime errors.
- Do not mark a requirement as completed unless it has been implemented and verified.
- Clearly identify any incomplete or unverified requirements.
- Keep the implementation simple, reliable and easy for every team member to understand and explain to judges.
- Explain important code sections in simple language.
- Do not hide bugs or fabricate test results.

10. Final objective

Our goal is to produce a fully working, crash-safe key-value database that satisfies the hackathon PDF requirements and can successfully demonstrate its correctness during the 15-minute judging session.

Start by analysing the entire PDF and presenting the proposed architecture. Do not rush into coding before explaining the design.
```

---

### Entry 2
- **Tool**: Google Antigravity / Gemini 3.8 Flash
- **Timestamp**: 2026-11-06T11:59:49+05:30
- **Prompt**:
```text
do it and give me the final project
```
