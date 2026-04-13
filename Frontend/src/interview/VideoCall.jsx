import { useCallback, useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import { useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { jwtDecode } from 'jwt-decode';
import './VideoCall.css';

const TARGET_VOICE_SAMPLE_RATE = 16000;
const DEFAULT_VOICE_CHUNK_SIZE = 4096;
const SUPPORTED_WHISPER_MODEL = 'base.en';

const getPreferredVoiceLanguage = () => {
    const saved = String(localStorage.getItem('voiceLanguage') || '').trim().toLowerCase();
    return !saved || saved === 'auto' ? 'en' : saved;
};

const getPreferredWhisperModel = () => {
    const saved = String(localStorage.getItem('voiceWhisperModel') || '').trim().toLowerCase();
    return saved === SUPPORTED_WHISPER_MODEL ? saved : SUPPORTED_WHISPER_MODEL;
};

const getNumericVoiceSetting = (key, fallback, min, max) => {
    const parsed = Number(localStorage.getItem(key));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const resampleFloat32Buffer = (input, sourceSampleRate, targetSampleRate) => {
    if (!input || input.length === 0) return new Float32Array();
    if (sourceSampleRate === targetSampleRate) return new Float32Array(input);

    const ratio = sourceSampleRate / targetSampleRate;
    const newLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(newLength);

    for (let index = 0; index < newLength; index += 1) {
        const sourcePosition = index * ratio;
        const leftIndex = Math.floor(sourcePosition);
        const rightIndex = Math.min(input.length - 1, leftIndex + 1);
        const weight = sourcePosition - leftIndex;
        output[index] = input[leftIndex] * (1 - weight) + input[rightIndex] * weight;
    }

    return output;
};

const float32ToInt16 = (input) => {
    const output = new Int16Array(input.length);

    for (let index = 0; index < input.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, input[index]));
        output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    return output;
};

const VideoCall = () => {
    const { interviewId } = useParams();
    const { user, loading: authLoading } = useAuth();
    const [localStream, setLocalStream] = useState(null);
    const [status, setStatus] = useState('loading');
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [isPeerConnected, setIsPeerConnected] = useState(false);
    const [userRole, setUserRole] = useState('');
    const [initialized, setInitialized] = useState(false);
    const [callTime, setCallTime] = useState(0);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [activeVideo, setActiveVideo] = useState(null);
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [interviewSummary, setInterviewSummary] = useState(null);
    const [transcript, setTranscript] = useState([]);
    const [isRecording, setIsRecording] = useState(false);
    const [isVoiceStreaming, setIsVoiceStreaming] = useState(false);
    const [voiceStreamStatus, setVoiceStreamStatus] = useState('idle');
    const [voiceStreamResult, setVoiceStreamResult] = useState(null);
    const [voiceStreamLiveTurns, setVoiceStreamLiveTurns] = useState([]);
    const [voiceStreamError, setVoiceStreamError] = useState(null);

    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const socketRef = useRef(null);
    const pcRef = useRef(null);
    const callTimerRef = useRef(null);
    const videoGridRef = useRef(null);
    const speechRecognitionRef = useRef(null);
    const localStreamRef = useRef(null);
    const voiceAudioContextRef = useRef(null);
    const voiceSourceNodeRef = useRef(null);
    const voiceProcessorRef = useRef(null);
    const voiceStreamIdRef = useRef(null);
    const voiceSequenceRef = useRef(0);
    const voiceWorkerReadyRef = useRef(false);

    const isTokenExpired = (jwtToken) => {
        if (!jwtToken) return true;
        try {
            const decoded = jwtDecode(jwtToken);
            if (!decoded?.exp) return true;
            return decoded.exp * 1000 <= Date.now();
        } catch {
            return true;
        }
    };

    // Role detection
    useEffect(() => {
        if (authLoading) return;

        const determineRole = () => {
            const explicitRole = localStorage.getItem('role');
            if (explicitRole) return explicitRole;

            if (user?.role) return user.role;

            const storedRole = localStorage.getItem('userRole');
            if (storedRole) return storedRole;

            const token = localStorage.getItem('token');
            if (token) {
                try {
                    const decoded = jwtDecode(token);
                    return decoded.role || 'CANDIDATE';
                } catch (error) {
                    console.error('Token decode error:', error);
                }
            }

            return 'CANDIDATE';
        };

        const role = determineRole();
        setUserRole(role);
        setInitialized(true);
    }, [user, authLoading]);

    // Timer effect
    useEffect(() => {
        if (status === 'connected') {
            callTimerRef.current = setInterval(() => {
                setCallTime(prev => prev + 1);
            }, 1000);
        } else {
            clearInterval(callTimerRef.current);
        }

        return () => clearInterval(callTimerRef.current);
    }, [status]);

    // Initialize speech recognition
    const initSpeechRecognition = () => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            const recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'en-US';

            recognition.onresult = (event) => {
                const newTranscript = [];
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    if (event.results[i].isFinal) {
                        newTranscript.push({
                            speaker: userRole === 'ENTERPRISE' ? 'Interviewer' : 'Candidate',
                            text: event.results[i][0].transcript,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
                setTranscript(prev => [...prev, ...newTranscript]);
            };

            recognition.onerror = () => {
                console.error('Speech recognition error');
            };

            speechRecognitionRef.current = recognition;
        }
    };

    const getVoiceSocketConfig = () => {
        return {
            sampleRate: TARGET_VOICE_SAMPLE_RATE,
            channels: 1,
            language: getPreferredVoiceLanguage(),
            whisperModel: getPreferredWhisperModel(),
            whisperDevice: localStorage.getItem('voiceWhisperDevice') || 'cpu',
            whisperComputeType: localStorage.getItem('voiceWhisperComputeType') || 'int8',
            enableDiarization: false,
            singleSpeakerLabel: 'CANDIDATE',
            vadThreshold: getNumericVoiceSetting('voiceVadThreshold', 0.35, 0.25, 0.9),
            minSpeechMs: getNumericVoiceSetting('voiceMinSpeechMs', 250, 150, 2000),
            minSilenceMs: getNumericVoiceSetting('voiceMinSilenceMs', 600, 400, 3000),
            maxChunkMs: getNumericVoiceSetting('voiceMaxChunkMs', 1500, 800, 6000),
            speechPadMs: getNumericVoiceSetting('voiceSpeechPadMs', 150, 50, 1000),
        };
    };

    const cleanupVoiceStream = () => {
        if (voiceProcessorRef.current) {
            try {
                voiceProcessorRef.current.disconnect();
            } catch (error) {
                console.warn('Voice processor disconnect failed:', error);
            }
            voiceProcessorRef.current.onaudioprocess = null;
            voiceProcessorRef.current = null;
        }

        if (voiceSourceNodeRef.current) {
            try {
                voiceSourceNodeRef.current.disconnect();
            } catch (error) {
                console.warn('Voice source disconnect failed:', error);
            }
            voiceSourceNodeRef.current = null;
        }

        if (voiceAudioContextRef.current) {
            voiceAudioContextRef.current.close().catch((error) => {
                console.warn('Voice audio context close failed:', error);
            });
            voiceAudioContextRef.current = null;
        }

        voiceStreamIdRef.current = null;
        voiceWorkerReadyRef.current = false;
        setIsVoiceStreaming(false);
        setVoiceStreamStatus('idle');
    };

    const startVoiceStream = async () => {
        if (!socketRef.current || !localStream) {
            setVoiceStreamError('Voice stream requires an active call and microphone access.');
            return;
        }

        if (isVoiceStreaming || voiceProcessorRef.current || voiceAudioContextRef.current) {
            return;
        }

        const streamId = `voice-${interviewId}-${Date.now()}-${voiceSequenceRef.current += 1}`;
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await audioContext.resume();
        const sourceNode = audioContext.createMediaStreamSource(localStream);
        const processor = audioContext.createScriptProcessor(DEFAULT_VOICE_CHUNK_SIZE, 1, 1);
        const sinkNode = audioContext.createGain();

        sinkNode.gain.value = 0;

        voiceAudioContextRef.current = audioContext;
        voiceSourceNodeRef.current = sourceNode;
        voiceProcessorRef.current = processor;
        voiceStreamIdRef.current = streamId;
        voiceWorkerReadyRef.current = false;
        setVoiceStreamError(null);
        setVoiceStreamStatus('starting');
        setVoiceStreamLiveTurns([]);
        setVoiceStreamResult(null);

        socketRef.current.emit('voice-stream:start', {
            streamId,
            interviewId,
            ...getVoiceSocketConfig(),
        });

        processor.onaudioprocess = (event) => {
            const inputBuffer = event.inputBuffer;
            const channelCount = inputBuffer.numberOfChannels || 1;
            const channelData = [];

            for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
                channelData.push(inputBuffer.getChannelData(channelIndex));
            }

            const monoLength = channelData[0]?.length || 0;
            if (monoLength === 0) return;

            const monoFloat = new Float32Array(monoLength);
            for (let sampleIndex = 0; sampleIndex < monoLength; sampleIndex += 1) {
                let sum = 0;
                for (let channelIndex = 0; channelIndex < channelData.length; channelIndex += 1) {
                    sum += channelData[channelIndex][sampleIndex] || 0;
                }
                monoFloat[sampleIndex] = sum / channelData.length;
            }

            const sourceSampleRate = audioContext.sampleRate || TARGET_VOICE_SAMPLE_RATE;
            const resampled = resampleFloat32Buffer(monoFloat, sourceSampleRate, TARGET_VOICE_SAMPLE_RATE);
            const int16Buffer = float32ToInt16(resampled);
            const binaryChunk = int16Buffer.buffer.slice(int16Buffer.byteOffset, int16Buffer.byteOffset + int16Buffer.byteLength);

            if (socketRef.current?.connected && voiceStreamIdRef.current) {
                socketRef.current.emit('voice-stream:chunk', {
                    streamId: voiceStreamIdRef.current,
                    chunk: binaryChunk,
                });
            }
        };

        sourceNode.connect(processor);
        processor.connect(sinkNode);
        sinkNode.connect(audioContext.destination);

        setIsVoiceStreaming(true);
        setVoiceStreamStatus('starting');
    };

    const stopVoiceStream = async () => {
        const streamId = voiceStreamIdRef.current;
        if (!streamId || !socketRef.current) {
            cleanupVoiceStream();
            return;
        }

        setVoiceStreamStatus('stopping');

        try {
            socketRef.current.emit('voice-stream:stop', { streamId });
        } finally {
            cleanupVoiceStream();
        }
    };

    const toggleVoiceStream = async () => {
        if (isVoiceStreaming) {
            await stopVoiceStream();
        } else {
            await startVoiceStream();
        }
    };

    // Toggle transcription
    const toggleTranscription = () => {
        if (isRecording) {
            speechRecognitionRef.current?.stop();
            setIsRecording(false);
        } else {
            if (!speechRecognitionRef.current) {
                initSpeechRecognition();
            }
            speechRecognitionRef.current?.start();
            setIsRecording(true);
        }
    };

    // Generate AI summary
    const generateSummary = async () => {
        setIsSummarizing(true);
        try {
            const response = await fetch('http://localhost:3001/api/interviews/summarize', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({
                    interviewId,
                    transcript,
                    userId: user?._id
                })
            });

            const data = await response.json();
            setInterviewSummary(data.summary);
        } catch (error) {
            console.error("Summary generation failed:", error);
        } finally {
            setIsSummarizing(false);
        }
    };

    const startCall = async () => {
        setStatus('connecting');
        try {
            socketRef.current.emit('join-interview', { interviewId });
            
            if (userRole === 'ENTERPRISE') {
                const offer = await pcRef.current.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: true
                });
                await pcRef.current.setLocalDescription(offer);
                socketRef.current.emit('offer', { interviewId, offer });
            }
            
            setStatus('connected');

            if (String(userRole || '').toUpperCase() === 'CANDIDATE') {
                try {
                    await startVoiceStream();
                } catch (streamError) {
                    console.warn('Candidate auto voice stream start failed:', streamError);
                }
            }
        } catch (err) {
            console.error('Call start error:', err);
            setStatus('error');
        }
    };

    const handleOffer = useCallback(async ({ offer }) => {
        try {
            if (userRole === 'CANDIDATE') {
                await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await pcRef.current.createAnswer();
                await pcRef.current.setLocalDescription(answer);
                socketRef.current.emit('answer', { interviewId, answer });
                socketRef.current.emit('peer-connected', { interviewId });
            }
        } catch (err) {
            console.error('Error handling offer:', err);
        }
    }, [interviewId, userRole]);

    const handleAnswer = useCallback(async ({ answer }) => {
        try {
            if (userRole === 'ENTERPRISE') {
                await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
                socketRef.current.emit('peer-connected', { interviewId });
            }
        } catch (err) {
            console.error('Error handling answer:', err);
        }
    }, [interviewId, userRole]);

    const handleICECandidate = useCallback(async ({ candidate }) => {
        try {
            if (candidate) {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
            }
        } catch (err) {
            console.error('Error adding ICE candidate:', err);
        }
    }, []);

    // WebRTC and Socket.io implementation
    useEffect(() => {
        if (!initialized) return;

        const init = async () => {
            try {
                setStatus('loading');
                
                // Get media stream
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        channelCount: 1,
                    }
                });
                setLocalStream(stream);
                localStreamRef.current = stream;
                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = stream;
                }

                // Connect to signaling server
                const token = localStorage.getItem('token');
                if (isTokenExpired(token)) {
                    setStatus('error');
                    console.warn('Cannot start call: session expired, please login again.');
                    return;
                }

                socketRef.current = io('http://localhost:3001', {
                    auth: { token },
                    transports: ['websocket'],
                    reconnection: false
                });

                socketRef.current.on('connect_error', (connectError) => {
                    if (connectError?.message === 'TOKEN_EXPIRED') {
                        console.warn('Video call socket rejected: token expired.');
                        socketRef.current?.disconnect();
                        setStatus('error');
                    }
                });

                // Create peer connection
                pcRef.current = new RTCPeerConnection({
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                        { urls: 'stun:stun2.l.google.com:19302' }
                    ],
                    iceCandidatePoolSize: 10
                });

                // Add local stream to connection
                stream.getTracks().forEach(track => {
                    pcRef.current.addTrack(track, stream);
                });

                // Setup event handlers
                pcRef.current.ontrack = (event) => {
                    if (!remoteVideoRef.current.srcObject) {
                        remoteVideoRef.current.srcObject = event.streams[0];
                        setIsPeerConnected(true);
                    }
                };

                pcRef.current.onicecandidate = (event) => {
                    if (event.candidate) {
                        socketRef.current.emit('ice-candidate', {
                            interviewId,
                            candidate: event.candidate
                        });
                    }
                };

                pcRef.current.oniceconnectionstatechange = () => {
                    if (pcRef.current.iceConnectionState === 'connected') {
                        setIsPeerConnected(true);
                    } else if (pcRef.current.iceConnectionState === 'disconnected') {
                        setStatus('disconnected');
                        setIsPeerConnected(false);
                    }
                };

                // Socket event handlers
                socketRef.current.on('offer', handleOffer);
                socketRef.current.on('answer', handleAnswer);
                socketRef.current.on('ice-candidate', handleICECandidate);
                socketRef.current.on('user-connected', (userId) => {
                    console.log('User connected:', userId);
                });
                socketRef.current.on('user-disconnected', () => {
                    setStatus('peer-disconnected');
                    setIsPeerConnected(false);
                });
                socketRef.current.on('peer-connected', () => {
                    setIsPeerConnected(true);
                });
                socketRef.current.on('voice-stream:started', ({ streamId }) => {
                    console.log('Voice stream started:', streamId);
                    setVoiceStreamStatus('starting');
                    setVoiceStreamLiveTurns([]);
                });
                socketRef.current.on('voice-stream:worker-ready', () => {
                    voiceWorkerReadyRef.current = true;
                    setVoiceStreamStatus('streaming');
                });
                socketRef.current.on('voice-stream:partial', (payload) => {
                    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
                    if (!text) return;

                    const sourceRole = String(payload?.sourceRole || '').toUpperCase();
                    if (String(userRole || '').toUpperCase() === 'ENTERPRISE' && sourceRole === 'ENTERPRISE') {
                        return;
                    }

                    const speaker = sourceRole === 'ENTERPRISE'
                        ? 'Recruiter'
                        : (sourceRole ? 'Candidate' : (payload?.speaker || 'CANDIDATE'));

                    setVoiceStreamLiveTurns((previous) => [
                        ...previous,
                        {
                            speaker,
                            text,
                            turn_index: payload?.turn_index,
                            start_ms: payload?.start_ms,
                            end_ms: payload?.end_ms,
                            sourceRole,
                            sourceUserId: payload?.sourceUserId,
                        },
                    ]);
                });
                socketRef.current.on('voice-stream:result', (result) => {
                    setVoiceStreamResult(result);
                    setVoiceStreamStatus('ready');
                });
                socketRef.current.on('voice-stream:error', (payload) => {
                    const message = typeof payload?.message === 'string' ? payload.message : 'Voice streaming failed.';
                    setVoiceStreamError(message);
                    setVoiceStreamStatus('error');
                    setIsVoiceStreaming(false);
                });

                setStatus('ready');
                
            } catch (err) {
                console.error('Initialization error:', err);
                setStatus('error');
            }
        };

        init();

        return () => {
            cleanupVoiceStream();
            if (pcRef.current) pcRef.current.close();
            if (socketRef.current) socketRef.current.disconnect();
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(track => track.stop());
            }
            if (speechRecognitionRef.current) {
                speechRecognitionRef.current.stop();
            }
            clearInterval(callTimerRef.current);
        };
    }, [initialized, interviewId, handleAnswer, handleICECandidate, handleOffer]);

    const toggleMute = () => {
        if (localStream) {
            localStream.getAudioTracks().forEach(track => {
                track.enabled = !track.enabled;
            });
            setIsMuted(!isMuted);
        }
    };

    const toggleVideo = () => {
        if (localStream) {
            localStream.getVideoTracks().forEach(track => {
                track.enabled = !track.enabled;
            });
            setIsVideoOff(!isVideoOff);
        }
    };

    const endCall = () => {
        if (voiceStreamIdRef.current && socketRef.current?.connected) {
            socketRef.current.emit('voice-stream:stop', { streamId: voiceStreamIdRef.current });
        }
        cleanupVoiceStream();
        if (pcRef.current) pcRef.current.close();
        if (socketRef.current) {
            socketRef.current.emit('leave-interview', { interviewId });
        }
        setStatus('disconnected');
        setIsPeerConnected(false);
        setCallTime(0);
    };

    const toggleFullscreen = (video) => {
        if (video === 'local') {
            if (!isFullscreen) {
                localVideoRef.current.requestFullscreen().catch(err => {
                    console.error('Error attempting to enable fullscreen:', err);
                });
            } else {
                document.exitFullscreen();
            }
            setActiveVideo('local');
        } else {
            if (!isFullscreen) {
                remoteVideoRef.current.requestFullscreen().catch(err => {
                    console.error('Error attempting to enable fullscreen:', err);
                });
            } else {
                document.exitFullscreen();
            }
            setActiveVideo('remote');
        }
        setIsFullscreen(!isFullscreen);
    };

    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    if (!initialized || authLoading) {
        return (
            <div className="loading-screen">
                <div className="loading-spinner"></div>
                <p>Loading user session...</p>
            </div>
        );
    }

    return (
        <div className={`video-call-container ${isFullscreen ? 'fullscreen' : ''}`}>
            <div className="call-header">
                <div className="header-left">
                    <h1 className="call-title">
                        {userRole === 'ENTERPRISE' ? 'Interview Session' : 'Interview Session'}
                    </h1>
                    <div className="call-info">
                        <span className="call-id">ID: {interviewId}</span>
                        <span className="call-role">{userRole === 'ENTERPRISE' ? 'Recruiter' : 'Candidate'}</span>
                    </div>
                </div>
                <div className="header-right">
                    <div className={`status-badge ${status.replace(' ', '-')}`}>
                        {status === 'connected' ? formatTime(callTime) : status}
                    </div>
                </div>
            </div>

            <div className="video-grid" ref={videoGridRef}>
                <div className={`video-container local-video ${isFullscreen && activeVideo === 'local' ? 'fullscreen-video' : ''}`}>
                    <div className="video-overlay">
                        <div className="user-info">
                            <div className="user-name">{user?.name || 'You'}</div>
                            <div className="user-status">
                                {isMuted ? 'Muted' : 'Unmuted'} • {isVideoOff ? 'Camera Off' : 'Camera On'}
                            </div>
                        </div>
                        <div className="video-controls">
                            <button onClick={toggleMute} className={`control-btn ${isMuted ? 'muted' : ''}`}>
                                <i className={`icon-${isMuted ? 'mic-off' : 'mic'}`}></i>
                            </button>
                            <button onClick={toggleVideo} className={`control-btn ${isVideoOff ? 'disabled' : ''}`}>
                                <i className={`icon-${isVideoOff ? 'video-off' : 'video'}`}></i>
                            </button>
                            <button 
                                onClick={() => toggleFullscreen('local')} 
                                className="control-btn"
                            >
                                <i className={`icon-${isFullscreen && activeVideo === 'local' ? 'minimize' : 'maximize'}`}></i>
                            </button>
                        </div>
                    </div>
                    <video 
                        ref={localVideoRef} 
                        autoPlay 
                        muted 
                        playsInline 
                        className={isVideoOff ? 'video-off' : ''}
                    />
                </div>

                <div className={`video-container remote-video ${isFullscreen && activeVideo === 'remote' ? 'fullscreen-video' : ''}`}>
                    <div className="video-overlay">
                        <div className="user-info">
                            <div className="user-name">
                                {userRole === 'ENTERPRISE' ? 'Candidate' : 'Interviewer'}
                            </div>
                            <div className="user-status">
                                {isPeerConnected ? 'Connected' : 'Connecting...'}
                            </div>
                        </div>
                        <div className="video-controls">
                            <button 
                                onClick={() => toggleFullscreen('remote')} 
                                className="control-btn"
                            >
                                <i className={`icon-${isFullscreen && activeVideo === 'remote' ? 'minimize' : 'maximize'}`}></i>
                            </button>
                        </div>
                    </div>
                    <video 
                        ref={remoteVideoRef} 
                        autoPlay 
                        playsInline 
                        className={!isPeerConnected ? 'video-off' : ''}
                    />
                    {!isPeerConnected && status === 'connected' && (
                        <div className="waiting-connection">
                            <div className="spinner"></div>
                            <p>Waiting for {userRole === 'ENTERPRISE' ? 'candidate' : 'interviewer'} to join...</p>
                        </div>
                    )}
                </div>
            </div>

            <div className="call-controls">
                {status === 'ready' && (
                    <button 
                        onClick={startCall} 
                        className="control-btn start-call"
                        data-testid="start-call-button"
                    >
                        <i className="icon-phone"></i>
                        {userRole === 'ENTERPRISE' ? 'Start Interview' : 'Join Interview'}
                    </button>
                )}
                
                {(status === 'connected' || status === 'connection-timeout') && (
                    <button 
                        onClick={endCall} 
                        className="control-btn end-call"
                    >
                        <i className="icon-phone-off"></i>
                        End Call
                    </button>
                )}
                
                {(status === 'error' || status === 'disconnected') && (
                    <button 
                        onClick={() => window.location.reload()} 
                        className="control-btn retry"
                    >
                        <i className="icon-refresh-cw"></i>
                        Retry Connection
                    </button>
                )}
            </div>

            {/* Summary Controls */}
            {userRole === 'ENTERPRISE' && (
                <div className="summary-controls">
                    {isRecording && (
                        <div className="recording-indicator">
                            <span>Recording</span>
                        </div>
                    )}
                    <button 
                        onClick={toggleTranscription}
                        className={`control-btn ${isRecording ? 'active' : ''}`}
                    >
                        {isRecording ? 'Stop Transcription' : 'Start Transcription'}
                    </button>

                    <button 
                        onClick={generateSummary}
                        disabled={isSummarizing || transcript.length === 0}
                        className="summary-btn"
                    >
                        {isSummarizing ? (
                            <span>Generating Summary...</span>
                        ) : (
                            <span>Generate AI Summary</span>
                        )}
                    </button>

                    <button
                        type="button"
                        onClick={toggleVoiceStream}
                        disabled={status !== 'connected' || !socketRef.current}
                        className={`summary-btn voice-stream-btn ${isVoiceStreaming ? 'active' : ''}`}
                    >
                        {isVoiceStreaming ? 'Stop Voice Stream' : 'Start Voice Stream'}
                    </button>

                    <div className="voice-stream-status">
                        <span>Voice stream: {voiceStreamStatus}</span>
                        {voiceStreamError && <span className="voice-stream-error">{voiceStreamError}</span>}
                    </div>

                    {voiceStreamLiveTurns.length > 0 && (
                        <div className="voice-stream-result">
                            <h3>Live Transcript (Realtime)</h3>
                            <p>{voiceStreamLiveTurns.length} partial updates</p>
                            <div className="voice-stream-turns">
                                {voiceStreamLiveTurns.slice(-4).map((turn, index) => (
                                    <div key={`${turn.turn_index || index}-${index}`} className="voice-stream-turn">
                                        <strong>{turn.speaker}</strong>
                                        <span>{turn.text}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {voiceStreamResult?.turns?.length > 0 && (
                        <div className="voice-stream-result">
                            <h3>Voice Engine Output</h3>
                            <p>{voiceStreamResult.turn_count || voiceStreamResult.turns.length} analyzed turns</p>
                            <div className="voice-stream-turns">
                                {voiceStreamResult.turns.slice(0, 4).map((turn, index) => (
                                    <div key={`${turn.speaker}-${turn.start_ms}-${index}`} className="voice-stream-turn">
                                        <strong>{turn.speaker}</strong>
                                        <span>{turn.text}</span>
                                        <small>{Math.round(turn.silence_before_ms || 0)} ms silence before</small>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {interviewSummary && (
                        <div className="summary-modal">
                            <h3>Interview Analysis</h3>
                            <div className="summary-content">
                                {interviewSummary.split('\n').map((para, i) => (
                                    <p key={i}>{para}</p>
                                ))}
                            </div>
                            <div className="summary-actions">
                                <button onClick={() => navigator.clipboard.writeText(interviewSummary)}>
                                    Copy to Clipboard
                                </button>
                                <button onClick={() => setInterviewSummary(null)}>
                                    Close
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            <div className="call-footer">
                <p className="footer-text">
                    {userRole === 'ENTERPRISE' 
                        ? 'Professional Interview Platform - Recruiter View'
                        : 'Professional Interview Platform - Candidate View'}
                </p>
                <p className="footer-help">
                    Having issues? <a href="#">Get help</a>
                </p>
            </div>
        </div>
    );
};

export default VideoCall;