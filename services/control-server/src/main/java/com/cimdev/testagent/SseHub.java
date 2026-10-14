package com.cimdev.testagent;

import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

@Component
class SseHub {
    private final Map<String, List<SseEmitter>> emitters = new ConcurrentHashMap<>();

    SseEmitter subscribe(String taskId, Object initial) {
        var emitter = new SseEmitter(0L);
        emitters.computeIfAbsent(taskId, ignored -> new CopyOnWriteArrayList<>()).add(emitter);
        emitter.onCompletion(() -> remove(taskId, emitter));
        emitter.onTimeout(() -> remove(taskId, emitter));
        send(emitter, "snapshot", initial);
        return emitter;
    }

    void publish(String taskId, String event, Object data) {
        for (var emitter : emitters.getOrDefault(taskId, List.of())) {
            if (!send(emitter, event, data)) remove(taskId, emitter);
        }
    }

    private boolean send(SseEmitter emitter, String event, Object data) {
        try {
            emitter.send(SseEmitter.event().name(event).data(data));
            return true;
        } catch (IOException error) {
            emitter.complete();
            return false;
        }
    }

    private void remove(String taskId, SseEmitter emitter) {
        var list = emitters.get(taskId);
        if (list != null) list.remove(emitter);
    }
}
