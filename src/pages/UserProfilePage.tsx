import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { usersApi } from '../lib/api/users';
import { OrbitUser } from '../types/database';
import { LevelBadge } from '../components/common/LevelBadge';
import { seesProgression } from '../lib/roles';
import { SafeLink } from '../components/common/SafeLink';
import {
  Mail,
  MapPin,
  Calendar,
  Award,
  CheckSquare,
  MessageCircle,
  Shield,
  GraduationCap,
  Trophy,
  Loader2,
  ArrowLeft,
  Edit2,
  Twitter,
  Linkedin,
  Github,
  UserPlus,
  UserCheck,
  UserX,
} from 'lucide-react';
import { logError } from '../lib/monitoring';
import toast from 'react-hot-toast';
import { convexHttp as convex } from '../lib/convex';
import { api } from '../../convex/_generated/api';
import { authService } from '../lib/auth';
import { formatDate } from '../lib/utils/date';

type FriendStatus = 'none' | 'pending_sent' | 'pending_received' | 'accepted';

export function UserProfilePage() {
  const navigate = useNavigate();
  const { userId } = useParams<{ userId?: string }>();
  const { user: currentUser } = useAuth();
  const [user, setUser] = useState<OrbitUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'about' | 'activity'>('about');
  const [friendStatus, setFriendStatus] = useState<FriendStatus>('none');
  const [friendshipId, setFriendshipId] = useState<string | null>(null);
  const [friendLoading, setFriendLoading] = useState(false);

  const isOwnProfile = !userId || userId === currentUser?.id;
  const profileUserId = userId || currentUser?.id;

  /**
   * Which fetch is allowed to write state, one ticket per loader.
   *
   * Both loads are keyed by the route's userId, and navigating profile A →
   * profile B re-runs them with no cancellation — A's slower response landing
   * last painted A's profile, or A's friendship status and its action button,
   * under B's URL. The same guard SubmissionReviewPage and EmailLogsPage
   * carry; separate refs because the two loads run in parallel and must not
   * invalidate each other.
   */
  const currentProfileRequest = useRef(0);
  const currentFriendRequest = useRef(0);

  useEffect(() => {
    if (profileUserId) {
      loadUserProfile();
      if (!isOwnProfile && currentUser?.id) {
        loadFriendStatus();
      }
    }
  }, [profileUserId]);

  /**
   * Connections, on Convex.
   *
   * All four of these were queries the browser ran directly against
   * orbit_friendships, a table with no RLS:
   *
   *  - the status read was an `.or(and(...),and(...))` filter string with two
   *    raw ids interpolated into it;
   *  - the request INSERT supplied its own user_id, so it could be sent as
   *    somebody else, and nothing stopped a duplicate or a self-request;
   *  - accept UPDATEd by row id with no check at all, so a requester could
   *    accept their own request and anyone holding an id could accept someone
   *    else's;
   *  - remove DELETEd by id with no ownership check.
   *
   * Each is now one mutation that derives the caller from the session.
   */
  const loadFriendStatus = async () => {
    const token = authService.getToken();
    if (!token || !profileUserId) return;

    const request = ++currentFriendRequest.current;
    try {
      const result = await convex.query(api.friendships.statusWith, {
        token,
        otherUserId: profileUserId as never,
      });

      // A stale status carries a stale friendshipId, and accept/remove act on
      // that id — so letting it land could point those actions at the edge
      // with the PREVIOUS profile, not the one on screen.
      if (request !== currentFriendRequest.current) return;

      setFriendshipId(result.id ?? null);

      if (result.status === 'none') setFriendStatus('none');
      else if (result.status === 'accepted') setFriendStatus('accepted');
      else setFriendStatus(result.isRequester ? 'pending_sent' : 'pending_received');
    } catch {
      if (request !== currentFriendRequest.current) return;
      setFriendStatus('none');
    }
  };

  const handleAddFriend = async () => {
    const token = authService.getToken();
    if (!token || !profileUserId) return;

    setFriendLoading(true);
    try {
      const result = await convex.mutation(api.friendships.request, {
        token,
        friendId: profileUserId as never,
      });
      if (!result.success) throw new Error(result.error);

      setFriendStatus('pending_sent');
      toast.success('Friend request sent!');
      await loadFriendStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send request');
    } finally {
      setFriendLoading(false);
    }
  };

  const handleAcceptFriend = async () => {
    const token = authService.getToken();
    if (!token || !friendshipId) return;

    setFriendLoading(true);
    try {
      const result = await convex.mutation(api.friendships.respond, {
        token,
        friendshipId: friendshipId as never,
        accept: true,
      });
      if (!result.success) throw new Error(result.error);

      setFriendStatus('accepted');
      toast.success('Friend request accepted!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to accept request');
    } finally {
      setFriendLoading(false);
    }
  };

  const handleRemoveFriend = async () => {
    const token = authService.getToken();
    if (!token || !profileUserId) return;

    setFriendLoading(true);
    try {
      // By the OTHER USER, not the row id. Either party may unfriend, but only
      // a party — the mutation resolves the edge itself.
      await convex.mutation(api.friendships.remove, {
        token,
        otherUserId: profileUserId as never,
      });

      setFriendStatus('none');
      setFriendshipId(null);
      toast.success('Removed from connections');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove');
    } finally {
      setFriendLoading(false);
    }
  };

  const loadUserProfile = async () => {
    const request = ++currentProfileRequest.current;
    try {
      setLoading(true);
      const userData = await usersApi.getUserById(profileUserId!);
      if (request !== currentProfileRequest.current) return;
      setUser(userData);
    } catch (error) {
      if (request !== currentProfileRequest.current) return;
      logError(error, { context: 'UserProfilePage.loadUserProfile' });
    } finally {
      if (request === currentProfileRequest.current) {
        setLoading(false);
      }
    }
  };

  const handleSendMessage = () => {
    if (user) {
      navigate(`/messages/${user.id}`);
    }
  };

  const handleEditProfile = () => {
    navigate('/profile/edit');
  };

  const getInitials = (name: string | null | undefined) => {
    return (name ?? 'U')
      .split(' ')
      .filter(Boolean)
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'U';
  };

  const getRoleIcon = (role: string) => {
    if (role === 'super_admin' || role === 'admin') return <Shield className="w-4 h-4" />;
    if (role === 'moderator') return <Award className="w-4 h-4" />;
    if (role === 'intern') return <GraduationCap className="w-4 h-4" />;
    return null;
  };

  const getRoleBadgeColor = (role: string) => {
    if (role === 'super_admin') return 'bg-purple-100 text-purple-700 border-purple-200';
    if (role === 'admin') return 'bg-red-100 text-red-700 border-red-200';
    if (role === 'moderator') return 'bg-blue-100 text-blue-700 border-blue-200';
    if (role === 'intern') return 'bg-green-100 text-green-700 border-green-200';
    return 'bg-slate-100 text-slate-700 border-slate-200';
  };

  const getRoleLabel = (role: string) => {
    if (role === 'super_admin') return 'Super Admin';
    if (role === 'admin') return 'Admin';
    if (role === 'moderator') return 'Moderator';
    if (role === 'intern') return 'Intern';
    return role;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-iih-green animate-spin mx-auto" />
          <p className="mt-4 text-slate-600">Loading profile...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-600">User not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {!isOwnProfile && (
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-2 text-slate-600 hover:text-slate-900 font-medium mb-6"
          >
            <ArrowLeft className="w-5 h-5" />
            Back
          </button>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="relative h-48 bg-slate-200">
            {user.cover_photo_url ? (
              <img
                src={user.cover_photo_url}
                alt="Cover"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full" />
            )}
          </div>

          <div className="relative px-6 pb-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4 -mt-16 mb-6">
              <div className="relative flex-shrink-0">
                <div className="w-32 h-32 rounded-full border-4 border-white bg-iih-green overflow-hidden">
                  {user.profile_photo_url ? (
                    <img
                      src={user.profile_photo_url}
                      alt={user.full_name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-white text-3xl font-bold">
                      {getInitials(user.full_name)}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <h1 className="text-3xl font-bold text-slate-800">{user.full_name}</h1>
                  {/* Progression is an intern device — see lib/roles. */}
                  {seesProgression(user) && (
                    <LevelBadge level={user.current_level || 1} size="lg" />
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {user.roles?.map((role) => (
                    <span
                      key={role}
                      className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium border ${getRoleBadgeColor(
                        role
                      )}`}
                    >
                      {getRoleIcon(role)}
                      {getRoleLabel(role)}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 flex-wrap">
                {isOwnProfile ? (
                  <button
                    onClick={handleEditProfile}
                    className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors"
                  >
                    <Edit2 className="w-4 h-4" />
                    Edit Profile
                  </button>
                ) : (
                  <>
                    {/* Friend action button */}
                    {friendStatus === 'none' && (
                      <button
                        onClick={handleAddFriend}
                        disabled={friendLoading}
                        className="bg-iih-green hover:bg-iih-green-dark text-white px-5 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors disabled:opacity-50"
                      >
                        <UserPlus className="w-4 h-4" />
                        Connect
                      </button>
                    )}
                    {friendStatus === 'pending_sent' && (
                      <button
                        onClick={handleRemoveFriend}
                        disabled={friendLoading}
                        className="border border-slate-200 text-slate-600 hover:bg-slate-50 px-5 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors disabled:opacity-50"
                      >
                        <UserX className="w-4 h-4" />
                        Cancel Request
                      </button>
                    )}
                    {friendStatus === 'pending_received' && (
                      <button
                        onClick={handleAcceptFriend}
                        disabled={friendLoading}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors disabled:opacity-50"
                      >
                        <UserCheck className="w-4 h-4" />
                        Accept Request
                      </button>
                    )}
                    {friendStatus === 'accepted' && (
                      <button
                        onClick={handleRemoveFriend}
                        disabled={friendLoading}
                        className="border border-slate-200 text-slate-600 hover:bg-slate-50 px-5 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors disabled:opacity-50"
                      >
                        <UserCheck className="w-4 h-4 text-iih-green" />
                        Connected
                      </button>
                    )}
                    <button
                      onClick={handleSendMessage}
                      className="border border-slate-200 hover:bg-slate-50 text-slate-700 px-5 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors"
                    >
                      <MessageCircle className="w-4 h-4" />
                      Message
                    </button>
                  </>
                )}
              </div>
            </div>

            {/*
              Points and level render only for interns. Staff never accrue
              either — `awardPoints` returns early for them — so these would
              read a permanent "0" and "Level 1", which states something true
              and useless. The grid narrows rather than leaving empty cells.
            */}
            <div
              className={`grid grid-cols-1 gap-4 mb-6 ${
                seesProgression(user) ? 'md:grid-cols-3' : 'md:grid-cols-1'
              }`}
            >
              {seesProgression(user) && (
                <>
              <div className="bg-slate-50 rounded-lg p-4">
                <div className="flex items-center gap-2 text-slate-600 mb-1">
                  <Trophy className="w-5 h-5" />
                  <span className="text-sm font-medium">Total Points</span>
                </div>
                <div className="text-2xl font-bold text-slate-800">
                  {user.total_points || 0}
                </div>
              </div>

              <div className="bg-slate-50 rounded-lg p-4">
                <div className="flex items-center gap-2 text-slate-600 mb-1">
                  <CheckSquare className="w-5 h-5" />
                  <span className="text-sm font-medium">Level</span>
                </div>
                <div className="text-2xl font-bold text-slate-800">
                  {user.current_level || 1}
                </div>
              </div>
                </>
              )}

              <div className="bg-slate-50 rounded-lg p-4">
                <div className="flex items-center gap-2 text-slate-600 mb-1">
                  <Calendar className="w-5 h-5" />
                  <span className="text-sm font-medium">Member Since</span>
                </div>
                <div className="text-lg font-bold text-slate-800">
                  {formatDate(user.created_at)}
                </div>
              </div>
            </div>

            <div className="border-b border-slate-200 mb-6">
              <div className="flex gap-4">
                <button
                  onClick={() => setActiveTab('about')}
                  className={`px-4 py-3 font-medium border-b-2 transition-colors ${
                    activeTab === 'about'
                      ? 'border-iih-green text-iih-green'
                      : 'border-transparent text-slate-600 hover:text-slate-800'
                  }`}
                >
                  About
                </button>
                <button
                  onClick={() => setActiveTab('activity')}
                  className={`px-4 py-3 font-medium border-b-2 transition-colors ${
                    activeTab === 'activity'
                      ? 'border-iih-green text-iih-green'
                      : 'border-transparent text-slate-600 hover:text-slate-800'
                  }`}
                >
                  Activity
                </button>
              </div>
            </div>

            {activeTab === 'about' && (
              <div className="space-y-6">
                {user.bio && (
                  <div>
                    <h3 className="text-lg font-bold text-slate-800 mb-2">Bio</h3>
                    <p className="text-slate-600">{user.bio}</p>
                  </div>
                )}

                <div>
                  <h3 className="text-lg font-bold text-slate-800 mb-3">Information</h3>
                  <div className="space-y-3">
                    {user.email && (
                      <div className="flex items-center gap-3 text-slate-600">
                        <Mail className="w-5 h-5" />
                        <span>{user.email}</span>
                      </div>
                    )}
                    {user.location && (
                      <div className="flex items-center gap-3 text-slate-600">
                        <MapPin className="w-5 h-5" />
                        <span>{user.location}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-3 text-slate-600">
                      <Calendar className="w-5 h-5" />
                      <span>Joined {formatDate(user.created_at)}</span>
                    </div>
                  </div>
                </div>

                {user.social_links && (
                  <div>
                    <h3 className="text-lg font-bold text-slate-800 mb-3">Social Links</h3>
                    <div className="flex gap-3">
                      {user.social_links.twitter && (
                        <a
                          href={`https://twitter.com/${user.social_links.twitter}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-700 transition-colors"
                        >
                          <Twitter className="w-5 h-5" />
                          Twitter
                        </a>
                      )}
                      {user.social_links.linkedin && (
                        <SafeLink
                          href={user.social_links.linkedin}
                          className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-700 transition-colors"
                        >
                          <Linkedin className="w-5 h-5" />
                          LinkedIn
                        </SafeLink>
                      )}
                      {user.social_links.github && (
                        <a
                          href={`https://github.com/${user.social_links.github}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-700 transition-colors"
                        >
                          <Github className="w-5 h-5" />
                          GitHub
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'activity' && (
              <div className="space-y-4">
                <p className="text-slate-600">Activity feed coming soon...</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
