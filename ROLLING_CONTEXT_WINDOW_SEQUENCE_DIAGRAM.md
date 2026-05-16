# Rolling Context Window Sequence Diagram

## Live Session Flow

```mermaid
sequenceDiagram
    autonumber
    participant STT as Live STT Stream
    participant Main as Main Process
    participant Session as SessionTracker
    participant Engine as IntelligenceEngine
    participant Cleaner as transcriptCleaner
    participant Temporal as TemporalContextBuilder
    participant LLM as WhatToAnswerLLM
    participant RAG as LiveRAGIndexer
    participant Store as VectorStore

    STT->>Main: transcript segment
    Main->>Session: handleTranscript(segment)
    alt segment is interim interviewer speech
        Session->>Session: store lastInterimInterviewer
    else segment is final
        Session->>Session: append to contextItems
        Session->>Session: append to fullTranscript
        Session->>Session: evict old prompt items
        Session->>Session: compactTranscriptIfNeeded()
    end

    Main->>RAG: feed final transcript segment(s)
    RAG->>RAG: buffer allSegments

    Main->>Engine: trigger suggestion / answer generation
    Engine->>Session: getContext(180)
    Engine->>Session: getLastInterimInterviewer()
    Engine->>Cleaner: prepareTranscriptForWhatToAnswer(turns)
    Engine->>Session: getAssistantResponseHistory()
    Engine->>Temporal: buildTemporalContext(context, history)
    Engine->>LLM: generate answer with cleaned transcript + temporal context
    LLM-->>Engine: answer
    Engine->>Session: addAssistantMessage(answer)
    Engine-->>Main: suggested answer

    loop every 30 seconds
        RAG->>RAG: slice unindexed tail
        RAG->>RAG: preprocess + chunk transcript
        RAG->>Store: save chunks
        RAG->>Store: store embeddings when ready
    end
```

## Transcript Compaction Flow

```mermaid
sequenceDiagram
    autonumber
    participant Session as SessionTracker
    participant Recap as RecapLLM

    Session->>Session: fullTranscript grows
    alt fullTranscript.length <= 1800
        Session->>Session: do nothing
    else fullTranscript.length > 1800
        Session->>Session: take oldest 500 entries
        Session->>Recap: summarize block into 3-5 bullets
        alt summary succeeds
            Recap-->>Session: epoch summary
            Session->>Session: push transcriptEpochSummaries
        else summary fails
            Session->>Session: push fallback marker
        end
        Session->>Session: cap epoch summaries to 5
        Session->>Session: remove summarized 500 entries
    end
```

## Meeting End Flow

```mermaid
sequenceDiagram
    autonumber
    participant Main as Main Process
    participant Session as SessionTracker
    participant Persist as MeetingPersistence
    participant RAG as RAGManager

    Main->>Session: flushInterimTranscript()
    Main->>Persist: snapshot current session
    Persist->>Session: getFullTranscript()
    Persist->>Session: getFullSessionContext()
    Persist->>Session: getFullUsage()
    Persist->>Session: getMeetingMetadata()
    Persist->>Session: reset()
    Persist->>Persist: generate title/summary in background
    Persist->>RAG: processMeeting(savedMeeting)
    RAG->>RAG: preprocess transcript
    RAG->>RAG: semantic chunking
    RAG->>RAG: embed + save chunks and meeting summary
```

## Practical Porting Notes

- The prompt-time window and retrieval-time window are separate pipelines
- Final transcript should feed both pipelines; interim transcript should only influence low-latency prompt generation
- Compaction should summarize fixed historical blocks, not the current active prompt window
- Meeting end should snapshot first, reset live state second, and index in background third
